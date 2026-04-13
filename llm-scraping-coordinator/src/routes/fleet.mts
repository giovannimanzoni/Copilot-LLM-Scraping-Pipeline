import Router from "@koa/router";
import {z} from "zod";

import {log} from "../logger.mjs";
import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {validate} from "../validate.mjs";

export const fleetRouter: Router = new Router();

fleetRouter.get("/fleet/state", async (ctx) => {
	const [state, phaseRaw, autoAdvanceRaw, reposEnabledRaw, stackEnabledRaw, mergeEnabledRaw, mergeSharedFsRaw, mergeTargetNode, phaseErrorRaw] = await Promise.all([
		redis.get(K.fleet_state),
		redis.get(K.fleet_phase),
		redis.get(K.fleet_auto_advance),
		redis.get(K.fleet_repos_enabled),
		redis.get(K.fleet_stack_enabled),
		redis.get(K.fleet_merge_enabled),
		redis.get(K.fleet_merge_shared_fs),
		redis.get(K.fleet_merge_target_node),
		redis.get(K.fleet_phase_error),
	]);
	ctx.body = {
		state: state ?? "running",
		phase: parseInt(phaseRaw ?? "0"),
		auto_advance: (autoAdvanceRaw ?? "0") === "1",
		repos_enabled: (reposEnabledRaw ?? "1") === "1",
		stack_enabled: (stackEnabledRaw ?? "1") === "1",
		merge_enabled: (mergeEnabledRaw ?? "1") === "1",
		merge_shared_fs: (mergeSharedFsRaw ?? "0") === "1",
		merge_target_node: mergeTargetNode ?? "",
		phase_error: (phaseErrorRaw ?? "0") === "1",
	};
});

fleetRouter.post("/fleet/phase/start", async (ctx) => {
	const phaseRaw = await redis.get(K.fleet_phase);
	const phase = parseInt(phaseRaw ?? "0");
	let newPhase = phase;

	if (phase === 0) {
		const [reposEnabledRaw, stackEnabledRaw, mergeEnabledRaw] = await Promise.all([
			redis.get(K.fleet_repos_enabled),
			redis.get(K.fleet_stack_enabled),
			redis.get(K.fleet_merge_enabled),
		]);
		const reposEnabled = (reposEnabledRaw ?? "1") === "1";
		const stackEnabled = (stackEnabledRaw ?? "1") === "1";
		const mergeEnabled = (mergeEnabledRaw ?? "1") === "1";
		if (!reposEnabled && !stackEnabled && !mergeEnabled) {
			ctx.status = 400;
			ctx.body = {error: "no phases enabled"};
			return;
		}
		if (reposEnabled) newPhase = 1;
		else if (stackEnabled) newPhase = 2;
		else newPhase = 3;
		await redis.set(K.fleet_phase, String(newPhase));
	}

	if (newPhase === 3) {
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
	await redis.set(K.fleet_state, "running");
	await redis.del(K.fleet_phase_error);
	log(`[fleet] phase ${newPhase} started`);
	ctx.body = {ok: true, state: "running", phase: newPhase};
});

fleetRouter.post("/fleet/phase/stop", async (ctx) => {
	await redis.set(K.fleet_state, "stopped");
	const phaseRaw = await redis.get(K.fleet_phase);
	const phase = parseInt(phaseRaw ?? "0");

	if (phase > 0 && phase < 4) {
		const {isPhaseComplete, hasPhaseErrors} = await import("../watchdog.mjs");
		if (await isPhaseComplete(phase)) {
			if (phase === 1 && await hasPhaseErrors(1)) {
				await redis.set(K.fleet_phase_error, "1");
				log(`[fleet] phase 1 stopped — failed repos present, staying at phase 1`);
				ctx.body = {ok: true, state: "stopped", phase};
				return;
			}
			const nextPhase = phase + 1;
			await redis.set(K.fleet_phase, String(nextPhase));
			log(`[fleet] phase ${phase} stopped — work complete, advancing to phase ${nextPhase}`);
			ctx.body = {ok: true, state: "stopped", phase: nextPhase};
			return;
		}
	}

	log(`[fleet] phase ${phase} stopped`);
	ctx.body = {ok: true, state: "stopped", phase};
});

fleetRouter.post("/fleet/auto_advance", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_auto_advance, enabled ? "1" : "0");
	log(`[fleet] auto_advance set to ${enabled}`);
	ctx.body = {ok: true, auto_advance: enabled};
});

fleetRouter.post("/fleet/repos_enabled", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_repos_enabled, enabled ? "1" : "0");
	log(`[fleet] repos_enabled set to ${enabled}`);
	ctx.body = {ok: true, repos_enabled: enabled};
});

fleetRouter.post("/fleet/stack_enabled", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_stack_enabled, enabled ? "1" : "0");
	log(`[fleet] stack_enabled set to ${enabled}`);
	ctx.body = {ok: true, stack_enabled: enabled};
});

fleetRouter.post("/fleet/merge_enabled", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_merge_enabled, enabled ? "1" : "0");
	log(`[fleet] merge_enabled set to ${enabled}`);
	ctx.body = {ok: true, merge_enabled: enabled};
});

fleetRouter.post("/fleet/merge_shared_fs", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_merge_shared_fs, enabled ? "1" : "0");
	log(`[fleet] merge_shared_fs set to ${enabled}`);
	ctx.body = {ok: true, merge_shared_fs: enabled};
});

fleetRouter.post("/fleet/merge_target_node", async (ctx) => {
	const {node_name} = validate(z.object({node_name: z.string()}), ctx.request.body);
	await redis.set(K.fleet_merge_target_node, node_name);
	log(`[fleet] merge_target_node set to '${node_name || "random"}'`);
	ctx.body = {ok: true, merge_target_node: node_name};
});

fleetRouter.post("/fleet/github_enabled", async (ctx) => {
	const {enabled} = validate(z.object({enabled: z.boolean()}), ctx.request.body);
	await redis.set(K.fleet_repos_enabled, enabled ? "1" : "0");
	log(`[fleet] repos_enabled set to ${enabled}`);
	ctx.body = {ok: true, repos_enabled: enabled};
});

fleetRouter.post("/fleet/phase/set", async (ctx) => {
	const {phase} = validate(z.object({phase: z.number().int().min(0).max(3)}), ctx.request.body);
	await redis.set(K.fleet_phase, String(phase));
	log(`[fleet] phase manually set to ${phase}`);
	ctx.body = {ok: true, phase};
});

// Legacy routes kept for backward compatibility
fleetRouter.post("/fleet/start", async (ctx) => {
	await redis.set(K.fleet_state, "running");
	ctx.body = {ok: true, state: "running"};
});

fleetRouter.post("/fleet/stop", async (ctx) => {
	await redis.set(K.fleet_state, "stopped");
	ctx.body = {ok: true, state: "stopped"};
});
