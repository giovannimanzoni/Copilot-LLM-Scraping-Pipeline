import Router from "@koa/router";
import {createReadStream, createWriteStream} from "fs";
import {mkdir, stat} from "fs/promises";
import {pipeline} from "stream/promises";
import {z} from "zod";

import {log} from "../logger.mjs";
import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {validate} from "../validate.mjs";

export const mergeRouter: Router = new Router();

mergeRouter.post("/node/merge_ready", async (ctx) => {
	const {node_id} = validate(z.object({node_id: z.number()}), ctx.request.body);
	const nodeName = await redis.hGet(K.node_stats(node_id), "node_name");
	if (!nodeName) {
		ctx.status = 400;
		ctx.body = {error: "node not registered"};
		return;
	}
	await redis.sAdd(K.merge_ready_node_ids, String(node_id));
	log(`[merge] node ${node_id} (${nodeName}) dataset save complete — ready for merge`);
	ctx.body = {ok: true};
});

mergeRouter.get("/merge/next/:nodeId", async (ctx) => {
	const nodeId = parseInt(ctx.params.nodeId);
	if (isNaN(nodeId)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeId"};
		return;
	}

	const [mergeEnabledRaw, phaseRaw, sharedFsRaw, targetNode] = await Promise.all([
		redis.get(K.fleet_merge_enabled),
		redis.get(K.fleet_phase),
		redis.get(K.fleet_merge_shared_fs),
		redis.get(K.fleet_merge_target_node),
	]);

	const mergeEnabled = (mergeEnabledRaw ?? "1") === "1";
	const phase = parseInt(phaseRaw ?? "0");

	if (!mergeEnabled || phase !== 3) {
		ctx.body = {task: null};
		return;
	}

	// Get this worker's node_name from its registered stats
	const nodeName = await redis.hGet(K.node_stats(nodeId), "node_name");
	if (!nodeName) {
		ctx.body = {task: null};
		return;
	}

	// Apply target node filter (empty string means random = any)
	if (targetNode && nodeName !== targetNode) {
		ctx.body = {task: null};
		return;
	}

	const sharedFs = (sharedFsRaw ?? "0") === "1";

	// Gate: all peer nodes must have signaled save-complete before we assign merge.
	// For shared FS, "peers" = every worker in the fleet.
	// For non-shared FS, "peers" = every worker on the same machine (same node_name).
	const [readyIds, registeredNodeIdsRaw] = await Promise.all([
		redis.sMembers(K.merge_ready_node_ids).then(s => new Set(s)),
		redis.sMembers(K.registered_node_ids),
	]);
	const peerChecks = registeredNodeIdsRaw.map(idStr =>
		redis.hGet(K.node_stats(Number(idStr)), "node_name").then(name => ({id: Number(idStr), name}))
	);
	const allNodes = await Promise.all(peerChecks);
	const peerIds = allNodes
		.filter(n => sharedFs ? n.name !== null : n.name === nodeName)
		.map(n => n.id);
	const allPeersReady = peerIds.length > 0 && peerIds.every(id => readyIds.has(String(id)));
	if (!allPeersReady) {
		ctx.body = {task: null};
		return;
	}

	if (sharedFs) {
		// Shared FS: only ONE worker total gets the task
		const mergeStatus = await redis.get(K.merge_status);
		if (mergeStatus !== null) {
			ctx.body = {task: null};
			return;
		}
		await Promise.all([
			redis.set(K.merge_status, "assigned"),
			redis.set(K.merge_assigned_node, String(nodeId)),
		]);
		log(`[merge] node ${nodeId} (${nodeName}) assigned single merge task (shared-FS)`);
		ctx.body = {task: {output_dir: "data3/final_dataset"}};
	} else {
		// No shared FS: one worker per machine (NODE_NAME) gets a task.
		// SADD returns 1 if newly added, 0 if already present — atomically decides the winner.
		const added = await redis.sAdd(K.merge_assigned_nodes, nodeName);
		if (added === 0) {
			ctx.body = {task: null};
			return;
		}
		log(`[merge] node ${nodeId} (${nodeName}) assigned local merge task`);
		ctx.body = {task: {output_dir: "data3/final_dataset"}};
	}
});

mergeRouter.post("/merge/progress", async (ctx) => {
	const {node_id, shards_loaded, shards_total, shard_name} = validate(
		z.object({
			node_id: z.number(),
			shards_loaded: z.number(),
			shards_total: z.number(),
			shard_name: z.string(),
		}),
		ctx.request.body,
	);

	const nodeName = await redis.hGet(K.node_stats(node_id), "node_name");
	const key = nodeName ?? `node-${node_id}`;

	await Promise.all([
		redis.hSet(K.merge_shards_loaded, key, String(shards_loaded)),
		redis.hSet(K.merge_shards_total, key, String(shards_total)),
		redis.hSet(K.merge_last_shard, key, shard_name),
	]);

	log(`[merge] ${key} shard progress: ${shards_loaded}/${shards_total} (${shard_name})`);
	ctx.body = {ok: true};
});

mergeRouter.post("/merge/transfer_progress", async (ctx) => {
	const {node_name, stage, bytes_done, bytes_total, peer} = validate(
		z.object({
			node_name: z.string(),
			stage: z.string(),
			bytes_done: z.number().int().min(0).default(0),
			bytes_total: z.number().int().min(0).default(0),
			peer: z.string().optional(),
		}),
		ctx.request.body,
	);

	const value: Record<string, unknown> = {stage, bytes_done, bytes_total};
	if (peer) value.peer = peer;
	await redis.hSet(K.merge_transfer, node_name, JSON.stringify(value));
	ctx.body = {ok: true};
});

mergeRouter.post("/merge/save_progress", async (ctx) => {
	const {node_id, pct} = validate(
		z.object({
			node_id: z.number(),
			pct: z.number().min(0).max(100),
		}),
		ctx.request.body,
	);

	const nodeName = await redis.hGet(K.node_stats(node_id), "node_name");
	const key = nodeName ?? `node-${node_id}`;

	await redis.hSet(K.merge_save_pct, key, String(pct));
	ctx.body = {ok: true};
});

mergeRouter.post("/merge/done", async (ctx) => {
	const {node_id, samples} = validate(
		z.object({node_id: z.number(), samples: z.number()}),
		ctx.request.body,
	);

	const [sharedFsRaw, nodeName] = await Promise.all([
		redis.get(K.fleet_merge_shared_fs),
		redis.hGet(K.node_stats(node_id), "node_name"),
	]);
	const sharedFs = (sharedFsRaw ?? "0") === "1";

	if (sharedFs) {
		await redis.set(K.merge_status, "done");
	} else if (nodeName) {
		await Promise.all([
			redis.sAdd(K.merge_done_nodes, nodeName),
			redis.hSet(K.merge_node_samples, nodeName, String(samples)),
		]);
	}

	const display = nodeName ?? `node-${node_id}`;
	log(`[merge] ${display} completed merge — ${samples.toLocaleString()} samples`);
	ctx.body = {ok: true};
});

// ─── Post-merge orchestration endpoints ──────────────────────────────────────

mergeRouter.get("/merge/node_names", async (ctx) => {
	const names = await redis.sMembers(K.registered_node_names);
	ctx.body = {node_names: names.sort()};
});

mergeRouter.post("/merge/claim_final", async (ctx) => {
	const {node_name} = validate(z.object({node_name: z.string()}), ctx.request.body);

	// If a target node is designated, only that node may claim the Final Merger role.
	const targetNode = await redis.get(K.fleet_merge_target_node);
	if (targetNode && node_name !== targetNode) {
		log(`[merge] '${node_name}' tried to claim Final Merger — designated target is '${targetNode}'`);
		ctx.body = {is_final_merger: false};
		return;
	}

	// SETNX: returns "OK" if claimed, null if already taken
	const result = await redis.set(K.merge_final_merger, node_name, {NX: true});
	const isFinalMerger = result === "OK";
	if (isFinalMerger) {
		log(`[merge] '${node_name}' claimed Final Merger role`);
	} else {
		const incumbent = await redis.get(K.merge_final_merger);
		log(`[merge] '${node_name}' tried to claim Final Merger — already taken by '${incumbent}'`);
	}
	ctx.body = {is_final_merger: isFinalMerger};
});

// Receives a zip of data3/final_dataset/ from a non-Final Merger machine (no shared FS).
// nodeName must be alphanumeric+hyphen/underscore only to prevent path traversal.
mergeRouter.post("/merge/upload_partial/:nodeName", async (ctx) => {
	const {nodeName} = ctx.params;
	if (!/^[a-zA-Z0-9_-]+$/.test(nodeName)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeName"};
		return;
	}
	await mkdir("./data3/partials", {recursive: true});
	const destPath = `./data3/partials/${nodeName}.zip`;
	await pipeline(ctx.req, createWriteStream(destPath));
	const {size} = await stat(destPath);
	await redis.sAdd(K.merge_partial_uploads, nodeName);
	log(`[merge] partial upload from '${nodeName}': ${size.toLocaleString()} bytes`);
	ctx.body = {ok: true, bytes: size};
});

mergeRouter.get("/merge/partials_status", async (ctx) => {
	const uploaded = await redis.sMembers(K.merge_partial_uploads);
	ctx.body = {uploaded: uploaded.sort()};
});

mergeRouter.get("/merge/download_partial/:nodeName", async (ctx) => {
	const {nodeName} = ctx.params;
	if (!/^[a-zA-Z0-9_-]+$/.test(nodeName)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeName"};
		return;
	}
	const zipPath = `./data3/partials/${nodeName}.zip`;
	try {
		const {size} = await stat(zipPath);
		ctx.set("Content-Type", "application/octet-stream");
		ctx.set("Content-Length", String(size));
		ctx.set("Content-Disposition", `attachment; filename="${nodeName}.zip"`);
		ctx.body = createReadStream(zipPath);
	} catch {
		ctx.status = 404;
		ctx.body = {error: "partial not found"};
	}
});

// Receives the final global dataset zip from the Final Merger.
mergeRouter.post("/merge/upload_final", async (ctx) => {
	await mkdir("./data3", {recursive: true});
	const destPath = "./data3/final_dataset.zip";
	await pipeline(ctx.req, createWriteStream(destPath));
	const {size} = await stat(destPath);
	await redis.set(K.merge_final_uploaded, "1");
	log(`[merge] final dataset uploaded: ${size.toLocaleString()} bytes — saved to ${destPath}`);
	ctx.body = {ok: true, bytes: size};
});

// Serves the final merged dataset zip for download.
mergeRouter.get("/merge/download_final", async (ctx) => {
	const zipPath = "./data3/final_dataset.zip";
	try {
		const {size} = await stat(zipPath);
		ctx.set("Content-Type", "application/octet-stream");
		ctx.set("Content-Length", String(size));
		ctx.set("Content-Disposition", 'attachment; filename="final_dataset.zip"');
		ctx.body = createReadStream(zipPath);
	} catch {
		ctx.status = 404;
		ctx.body = {error: "final dataset not yet available"};
	}
});

// Called by each machine's Merger when it has finished all work.
// When all registered machines have quit, the coordinator sets fleet state to "done".
mergeRouter.post("/merge/quit", async (ctx) => {
	const {node_name} = validate(z.object({node_name: z.string()}), ctx.request.body);
	await redis.sAdd(K.merge_quit_node_names, node_name);
	const [quitCount, registeredNames] = await Promise.all([
		redis.sCard(K.merge_quit_node_names),
		redis.sMembers(K.registered_node_names),
	]);
	const total = registeredNames.length;
	log(`[merge] quit from '${node_name}' — ${quitCount}/${total} machines done`);
	if (quitCount >= total && total > 0) {
		log("[merge] all machines done — setting fleet state to 'done'");
		await Promise.all([
			redis.set(K.fleet_state, "done"),
			redis.set(K.fleet_phase, "5"),
		]);
		ctx.body = {ok: true, coordinator_done: true};
	} else {
		ctx.body = {ok: true, coordinator_done: false};
	}
});
