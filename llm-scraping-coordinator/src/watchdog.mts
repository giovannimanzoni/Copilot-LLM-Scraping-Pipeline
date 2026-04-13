import {appendFile, mkdir} from "node:fs/promises";
import {join} from "node:path";

import * as Sentry from "@sentry/node";

import {REPO_TIMEOUT_S, STACK_TIMEOUT_S} from "./config.mjs";
import {error, log, warn} from "./logger.mjs";
import {redisClient as redis} from "./redis.mjs";
import {K} from "./redis-keys.mjs";

const CLUSTERDOWN_SENTRY_INTERVAL_MS = 10 * 60_000;
let lastClusterDownSentryTs = 0;

export async function recoverTimedOutRepos(): Promise<void> {
	const cutoff = Date.now() / 1000 - REPO_TIMEOUT_S;
	const timedOut = await redis.zRangeByScore(K.repos_assigned, "-inf", cutoff);
	if (timedOut.length === 0) return;

	for (const repo of timedOut) {
		await redis.zRem(K.repos_assigned, repo);
		await redis.sAdd(K.repos_pending, repo);
	}
	Sentry.addBreadcrumb({
		category: "recovery",
		message: `${timedOut.length} timed-out repos put back in pending`,
		level: "info",
	});
	log(`[recovery] ${timedOut.length} timed-out repos put back in pending`);
}

// Phases: 1=repos, 2=stack, 3=merge
export async function isPhaseComplete(phase: number): Promise<boolean> {
	if (phase === 1) {
		const reposEnabled = await redis.get(K.fleet_repos_enabled);
		if ((reposEnabled ?? "1") === "0") return true;
	}
	if (phase === 2) {
		const stackEnabled = await redis.get(K.fleet_stack_enabled);
		if ((stackEnabled ?? "1") === "0") return true;
	}
	if (phase === 3) {
		const mergeEnabled = await redis.get(K.fleet_merge_enabled);
		if ((mergeEnabled ?? "1") === "0") return true;
	}

	if (phase === 1) {
		const [rp, ra, rd, rpr, rrq] = await Promise.all([
			redis.sCard(K.repos_pending),
			redis.zCard(K.repos_assigned),
			redis.sCard(K.repos_done),
			redis.sCard(K.repos_problematic),
			redis.lLen(K.repos_retry_queue),
		]);
		return rp === 0 && ra === 0 && rrq === 0 && (rd + rpr > 0);
	} else if (phase === 2) {
		const [sp, sa, sd, spr] = await Promise.all([
			redis.lLen(K.stack_pending),
			redis.zCard(K.stack_assigned),
			redis.sCard(K.stack_done),
			redis.sCard(K.stack_problematic),
		]);
		return sp === 0 && sa === 0 && (sd + spr > 0);
	} else if (phase === 3) {
		const sharedFsRaw = await redis.get(K.fleet_merge_shared_fs);
		const sharedFs = (sharedFsRaw ?? "0") === "1";

		if (sharedFs) {
			const mergeStatus = await redis.get(K.merge_status);
			return mergeStatus === "done";
		}

		// Non-shared FS: /merge/done reflects only each machine's LOCAL merge completion.
		// The Final Merger still needs to download all partials, integrate them, and upload
		// the final dataset — which can take hours after the last /merge/done.  Use
		// merge_final_uploaded as the completion signal instead: it is set only when the
		// Final Merger has finished the entire global merge and uploaded the result.
		const finalUploaded = await redis.get(K.merge_final_uploaded);
		return finalUploaded === "1";
	}
	return false;
}

async function isPhaseEnabled(phase: number): Promise<boolean> {
	if (phase === 1) return (await redis.get(K.fleet_repos_enabled) ?? "1") === "1";
	if (phase === 2) return (await redis.get(K.fleet_stack_enabled) ?? "1") === "1";
	if (phase === 3) return (await redis.get(K.fleet_merge_enabled) ?? "1") === "1";
	return false;
}

export async function hasPhaseErrors(phase: number): Promise<boolean> {
	if (phase === 1) {
		const problematic = await redis.sCard(K.repos_problematic);
		return problematic > 0;
	}
	if (phase === 2) {
		const problematic = await redis.sCard(K.stack_problematic);
		return problematic > 0;
	}
	return false;
}

async function checkTimedOutStackTasks(): Promise<void> {
	const cutoff = Date.now() / 1000 - STACK_TIMEOUT_S;
	const timedOut = await redis.zRangeByScore(K.stack_assigned, "-inf", cutoff);
	for (const taskKey of timedOut) {
		const taskJson = await redis.hGet(K.stack_assigned_tasks, taskKey);
		await redis.zRem(K.stack_assigned, taskKey);
		await redis.hDel(K.stack_assigned_tasks, taskKey);
		await redis.sAdd(K.stack_problematic, taskKey);
		if (taskJson) {
			await redis.hSet(K.stack_problematic_tasks, taskKey, taskJson);
		}
		Sentry.captureMessage(`Stack task timed out, marked problematic: ${taskKey}`, {
			level: "warning",
			tags: {component: "watchdog"},
		});
		warn(`[watchdog] stack task ${taskKey} marcato problematic (>45 min senza /stack/done)`);
	}
}

async function writeCancelledLog(): Promise<void> {
	const cancelled = await redis.sMembers(K.repos_cancelled);
	if (cancelled.length === 0) return;
	const dir = join(process.cwd(), "data1");
	await mkdir(dir, {recursive: true});
	const path = join(dir, "cancelled.log");
	await appendFile(path, cancelled.map((r) => r + "\n").join(""));
	log(`[phase1] wrote ${cancelled.length} cancelled repos to data1/cancelled.log`);
}

export function startWatchdog(): void {
	setInterval(() => {
		recoverTimedOutRepos().catch((err) => {
			Sentry.captureException(err, {tags: {component: "watchdog"}});
			error("[watchdog error]", err);
		});
	}, 60_000);

	setInterval(() => {
		checkTimedOutStackTasks().catch((err) => {
			Sentry.captureException(err, {tags: {component: "watchdog-stack"}});
			error("[watchdog-stack error]", err);
		});
	}, 5 * 60_000);

	setInterval(async () => {
		try {
			const [stateRaw, phaseRaw, autoAdvanceRaw] = await Promise.all([
				redis.get(K.fleet_state),
				redis.get(K.fleet_phase),
				redis.get(K.fleet_auto_advance),
			]);
			const state = stateRaw ?? "running";
			const phase = parseInt(phaseRaw ?? "0");
			const autoAdvance = (autoAdvanceRaw ?? "0") === "1";

			if (state !== "running" || phase === 0 || phase >= 4) return;
			if (!await isPhaseComplete(phase)) return;

			const nextPhase = phase + 1;
			log(`Phase ${phase}: completed.`);

			if (phase === 1) {
				writeCancelledLog().catch((err) => {
					Sentry.captureException(err, {tags: {component: "phase-watcher"}});
					error("[phase1] failed to write cancelled.log", err);
				});
			}

			// Phase 1 (repos) errors: stop and wait for retry
			if (phase === 1 && await hasPhaseErrors(1)) {
				await redis.set(K.fleet_state, "stopped");
				await redis.set(K.fleet_phase_error, "1");
				warn(`[fleet] phase 1 complete with failed repos — stopped for retry`);
				Sentry.captureMessage(`Phase 1 complete with failed repos — stopped for retry`, {
					level: "warning",
					tags: {component: "phase-watcher"},
				});
				return;
			}

			if (autoAdvance && nextPhase <= 3) {
				const errors = await hasPhaseErrors(phase);
				if (errors) {
					await redis.set(K.fleet_phase, String(nextPhase));
					await redis.set(K.fleet_state, "stopped");
					await redis.set(K.fleet_phase_error, "1");
					warn(`[fleet] phase ${phase} complete with errors — auto-advance halted at phase ${nextPhase}`);
					Sentry.captureMessage(`Phase ${phase} complete with errors, auto-advance halted`, {
						level: "warning",
						tags: {component: "phase-watcher"},
					});
				} else if (!await isPhaseEnabled(nextPhase)) {
					let targetPhase = nextPhase + 1;
					while (targetPhase <= 3 && !await isPhaseEnabled(targetPhase)) {
						targetPhase++;
					}

					if (targetPhase > 3) {
						await redis.set(K.fleet_phase, String(nextPhase));
						await redis.set(K.fleet_state, "stopped");
						log(`[fleet] phase ${phase} complete — phase ${nextPhase} disabled, all remaining phases disabled, stopping`);
					} else {
						if (targetPhase === 3) await clearMergeState();
						await redis.set(K.fleet_phase, String(targetPhase));
						await redis.set(K.fleet_state, "running");
						log(`[fleet] phase ${phase} complete — phase ${nextPhase} disabled, auto-advancing to phase ${targetPhase}`);
					}
				} else {
					if (nextPhase === 3) await clearMergeState();
					await redis.set(K.fleet_phase, String(nextPhase));
					await redis.set(K.fleet_state, "running");
					log(`[fleet] phase ${phase} complete — auto-advancing to phase ${nextPhase}`);
					Sentry.captureMessage(`Phase ${phase} complete, auto-advancing to phase ${nextPhase}`, {
						level: "info",
						tags: {component: "phase-watcher"},
					});
				}
			} else {
				if (nextPhase === 3) await clearMergeState();
				await redis.set(K.fleet_phase, String(nextPhase));
				await redis.set(K.fleet_state, "stopped");
				const msg = nextPhase > 3
					? `[fleet] phase ${phase} complete — all phases done`
					: `[fleet] phase ${phase} complete — waiting for manual start of phase ${nextPhase}`;
				log(msg);
				if (nextPhase <= 3) log(`Phase ${nextPhase}: waiting to start`);
				Sentry.captureMessage(`Phase ${phase} complete${nextPhase > 3 ? " — all done" : ` — waiting for phase ${nextPhase}`}`, {
					level: "info",
					tags: {component: "phase-watcher"},
				});
			}
		} catch (err) {
			const isClusterDown = err instanceof Error && err.message.includes("CLUSTERDOWN");
			if (isClusterDown) {
				const now = Date.now();
				if (now - lastClusterDownSentryTs >= CLUSTERDOWN_SENTRY_INTERVAL_MS) {
					lastClusterDownSentryTs = now;
					Sentry.captureException(err, {tags: {component: "phase-watcher"}});
				}
			} else {
				Sentry.captureException(err, {tags: {component: "phase-watcher"}});
			}
			error("[phase-watcher error]", err);
		}
	}, 5_000);

	// worker_id → timestamp of last console warn (Sentry fires only once on first detection)
	const unresponsiveWorkers = new Map<number, number>();

	setInterval(async () => {
		try {
			const now = Date.now();
			const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
			for (const i of registeredIds) {
				const alive = await redis.exists(K.heartbeat(i));
				if (!alive) {
					const lastSeen = await redis.hGet(K.node_stats(i), "last_heartbeat");
					if (lastSeen) {
						const age = now - parseInt(lastSeen);
						if (age > 8 * 60 * 1000) {
							const ageMin = Math.round(age / 60000);
							const lastLogged = unresponsiveWorkers.get(i);
							if (lastLogged === undefined) {
								// First detection: notify Sentry once and log to console
								unresponsiveWorkers.set(i, now);
								Sentry.captureMessage(`Worker ${i} hasn't responded since ${ageMin} minuti`, {
									level: "warning",
									tags: {component: "watchdog", worker_id: String(i)},
								});
								warn(`[watchdog] Worker ${i} hasn't responded since ${ageMin} min`);
							} else if (now - lastLogged >= 10 * 60_000) {
								// Still unresponsive: repeat console log every 10 min (no Sentry)
								unresponsiveWorkers.set(i, now);
								warn(`[watchdog] Worker ${i} hasn't responded since ${ageMin} min`);
							}
						}
					}
				} else if (unresponsiveWorkers.has(i)) {
					unresponsiveWorkers.delete(i);
					log(`[watchdog] Worker ${i} back online`);
					Sentry.captureMessage(`Worker ${i} back online`, {
						level: "info",
						tags: {component: "watchdog", worker_id: String(i)},
					});
				}
			}
		} catch (err) {
			Sentry.captureException(err, {tags: {component: "watchdog-heartbeat"}});
		}
	}, 2 * 60_000);
}

async function clearMergeState(): Promise<void> {
	await Promise.all([
		redis.del(K.merge_ready_node_ids),
		redis.del(K.merge_status),
		redis.del(K.merge_assigned_node),
		redis.del(K.merge_assigned_nodes),
		redis.del(K.merge_done_nodes),
		redis.del(K.merge_node_samples),
		redis.del(K.merge_shards_loaded),
		redis.del(K.merge_shards_total),
		redis.del(K.merge_last_shard),
		redis.del(K.merge_save_pct),
		redis.del(K.merge_final_merger),
		redis.del(K.merge_partial_uploads),
		redis.del(K.merge_quit_node_names),
		redis.del(K.merge_final_uploaded),
	]);
	log("[fleet] clearing stale merge state before entering phase 3");
}
