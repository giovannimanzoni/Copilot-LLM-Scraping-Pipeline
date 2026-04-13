import {readFileSync} from "node:fs";
import {rm} from "node:fs/promises";
import {resolve} from "node:path";

import Router from "@koa/router";
import * as Sentry from "@sentry/node";

import {log, warn} from "../logger.mjs";
import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {seedStackTasks} from "../stack-seeder.mjs";

const REPOS_FILE = resolve(process.cwd(), "input_data/repos_found.txt");

export const resetRouter: Router = new Router();

resetRouter.post("/reset/all", async (ctx) => {
	const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
	const allKeys = [
		K.repos_pending, K.repos_assigned, K.repos_done, K.repos_problematic, K.repos_cancelled,
		K.repos_retry_queue, K.repos_retry_active,
		K.stack_pending, K.stack_assigned, K.stack_assigned_tasks,
		K.stack_done, K.stack_problematic, K.stack_problematic_tasks,
		K.merge_ready_node_ids, K.merge_status, K.merge_assigned_node,
		K.merge_assigned_nodes, K.merge_done_nodes, K.merge_node_samples,
		K.merge_shards_loaded, K.merge_shards_total, K.merge_last_shard, K.merge_save_pct,
		K.merge_final_merger, K.merge_partial_uploads, K.merge_quit_node_names,
		K.merge_final_uploaded, K.merge_transfer,
		K.registered_node_names, K.registered_node_ids, K.registered_node_hashes,
		K.registered_node_offsets, K.registered_next_node_id,
	];
	for (const key of allKeys) {
		await redis.del(key);
	}
	for (const i of registeredIds) {
		await redis.del(K.node_stats(i));
		await redis.del(K.heartbeat(i));
	}
	await redis.set(K.fleet_phase, "0");
	await redis.set(K.fleet_state, "stopped");
	await redis.del(K.fleet_phase_error);
	await redis.set(K.fleet_auto_advance, "0");
	await redis.set(K.fleet_repos_enabled, "0");
	await redis.set(K.fleet_stack_enabled, "0");
	await redis.set(K.fleet_merge_enabled, "0");
	await redis.set(K.fleet_merge_shared_fs, "0");
	await redis.del(K.fleet_merge_target_node);
	// Delete uploaded partials and final dataset zip from disk
	await rm("./data3/partials", {recursive: true, force: true});
	await rm("./data3/final_dataset.zip", {force: true});
	warn("[reset] Full reset: data3/partials/ and data3/final_dataset.zip deleted");
	// Re-seed repos from repos_found.txt
	try {
		const content = readFileSync(REPOS_FILE, "utf8");
		const repos = content.split("\n").map((l) => l.trim()).filter(Boolean);
		if (repos.length > 0) {
			const BATCH = 1000;
			for (let i = 0; i < repos.length; i += BATCH) {
				await redis.sAdd(K.repos_pending, repos.slice(i, i + BATCH));
			}
			warn(`[reset] Re-seeded ${repos.length} repos from repos_found.txt`);
		}
	} catch { /* file not found — coordinator would not have started if it were truly missing */ }
	await seedStackTasks();
	Sentry.captureMessage("Full reset performed via dashboard", {level: "warning", tags: {component: "reset"}});
	warn("[reset] Full reset: all data wiped and re-seeded");
	ctx.body = {ok: true};
});

resetRouter.post("/reset/stack", async (ctx) => {
	for (const key of [K.stack_pending, K.stack_assigned, K.stack_assigned_tasks, K.stack_problematic, K.stack_problematic_tasks]) {
		await redis.del(key);
	}
	await redis.del(K.fleet_phase_error);
	const seeded = await seedStackTasks(true);
	Sentry.captureMessage("Stack reset performed via dashboard", {level: "warning", tags: {component: "reset"}});
	warn(`[reset] Stack reset: ${seeded} task seeded (skipped already-done)`);
	ctx.body = {ok: true, tasks_seeded: seeded};
});

resetRouter.post("/reset/phase/stack", async (ctx) => {
	for (const key of [K.stack_pending, K.stack_assigned, K.stack_assigned_tasks, K.stack_done, K.stack_problematic, K.stack_problematic_tasks]) {
		await redis.del(key);
	}
	const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
	for (const i of registeredIds) {
		await redis.hDel(K.node_stats(i), ["stack_scanned", "stack_samples", "stack_samples_done", "current_stack", "stack_total"]);
	}
	await redis.del(K.fleet_phase_error);
	await seedStackTasks();
	Sentry.captureMessage("Stack phase reset via dashboard", {level: "warning", tags: {component: "reset"}});
	warn("[reset] Stack phase: all stack data wiped and re-seeded");
	ctx.body = {ok: true};
});

resetRouter.post("/reset/phase/repos", async (ctx) => {
	await redis.del(K.repos_pending);
	await redis.del(K.repos_assigned);
	await redis.del(K.repos_done);
	await redis.del(K.repos_problematic);
	await redis.del(K.repos_cancelled);
	await redis.del(K.repos_retry_queue);
	await redis.del(K.repos_retry_active);
	const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
	for (const i of registeredIds) {
		await redis.hDel(K.node_stats(i), ["repos_done", "repos_registered", "repos_failed", "samples_collected", "current_repo"]);
	}
	await redis.del(K.fleet_phase_error);
	// Re-seed repos from repos_found.txt
	try {
		const content = readFileSync(REPOS_FILE, "utf8");
		const repos = content.split("\n").map((l) => l.trim()).filter(Boolean);
		if (repos.length > 0) {
			const BATCH = 1000;
			for (let i = 0; i < repos.length; i += BATCH) {
				await redis.sAdd(K.repos_pending, repos.slice(i, i + BATCH));
			}
			warn(`[reset] Repos phase re-seeded ${repos.length} repos from repos_found.txt`);
		}
	} catch { /* repos_found.txt not found */ }
	Sentry.captureMessage("Repos phase reset via dashboard", {level: "warning", tags: {component: "reset"}});
	warn("[reset] Repos phase: all repos data wiped and re-seeded from repos_found.txt");
	ctx.body = {ok: true};
});

resetRouter.post("/reset/repos_problematic", async (ctx) => {
	// Clear any previous retry state
	await redis.del(K.repos_retry_queue);
	await redis.del(K.repos_retry_active);

	const members = await redis.sMembers(K.repos_problematic);
	if (members.length === 0) {
		ctx.body = {ok: true, requeued: 0};
		return;
	}

	// Move all problematic repos into the retry queue (sequential dispatch)
	await redis.del(K.repos_problematic);
	for (const repo of members) {
		await redis.rPush(K.repos_retry_queue, repo);
	}

	// Dispatch the first one into pending immediately
	const first = await redis.lPop(K.repos_retry_queue);
	if (first) {
		await redis.sAdd(K.repos_pending, first);
		await redis.set(K.repos_retry_active, first);
		log(`[retry] dispatched first repo: ${first}`);
	}

	const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
	for (const i of registeredIds) {
		await redis.hDel(K.node_stats(i), "repos_failed");
	}
	await redis.del(K.fleet_phase_error);
	warn(`[reset] Repos problematic: ${members.length} repo(s) queued for sequential retry, failed counters cleared`);
	ctx.body = {ok: true, requeued: members.length};
});

resetRouter.post("/reset/phase/merge", async (ctx) => {
	for (const key of [
		K.merge_ready_node_ids, K.merge_status, K.merge_assigned_node,
		K.merge_assigned_nodes, K.merge_done_nodes, K.merge_node_samples,
		K.merge_shards_loaded, K.merge_shards_total, K.merge_last_shard, K.merge_save_pct,
		K.merge_final_merger, K.merge_partial_uploads, K.merge_quit_node_names,
		K.merge_final_uploaded, K.merge_transfer,
	]) {
		await redis.del(key);
	}
	await redis.set(K.fleet_state, "stopped");
	await redis.set(K.fleet_phase, "3");
	await redis.del(K.fleet_phase_error);
	await redis.set(K.fleet_merge_enabled, "0");
	await redis.del(K.fleet_merge_target_node);
	await rm("./data3/partials", {recursive: true, force: true});
	await rm("./data3/final_dataset.zip", {force: true});
	Sentry.captureMessage("Merge phase reset via dashboard", {level: "warning", tags: {component: "reset"}});
	warn("[reset] Merge phase: all merge data wiped, fleet stopped, data3/ artifacts deleted");
	ctx.body = {ok: true};
});

resetRouter.post("/reset/problematic", async (ctx) => {
	const members = await redis.sMembers(K.stack_problematic);
	for (const key of members) {
		const taskJson = await redis.hGet(K.stack_problematic_tasks, key);
		if (taskJson) {
			await redis.rPush(K.stack_pending, taskJson);
		}
		await redis.sRem(K.stack_problematic, key);
		await redis.hDel(K.stack_problematic_tasks, key);
	}
	await redis.del(K.fleet_phase_error);
	warn(`[reset] Problematic reset: ${members.length} task(s) re-queued`);
	ctx.body = {ok: true, requeued: members.length};
});

resetRouter.post("/reset/worker_names", async (ctx) => {
	const registeredIds = (await redis.sMembers(K.registered_node_ids)).map(Number);
	await Promise.all([
		...registeredIds.map((i) => redis.hDel(K.node_stats(i), "node_name")),
		redis.del(K.registered_node_names),
		redis.del(K.registered_node_hashes),
		redis.del(K.registered_node_offsets),
		redis.del(K.registered_next_node_id),
	]);
	warn("[reset] Worker names, hashes and offsets cleared");
	ctx.body = {ok: true};
});
