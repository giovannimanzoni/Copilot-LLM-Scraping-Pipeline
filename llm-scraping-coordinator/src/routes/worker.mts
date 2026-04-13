import Router from "@koa/router";
import {z} from "zod";

import {FILE_EXTENSIONS, THE_STACK_LANGUAGES} from "../config.mjs";
import {log, warn} from "../logger.mjs";
import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {validate} from "../validate.mjs";

export const workerRouter: Router = new Router();

workerRouter.get("/config", async (ctx) => {
	ctx.body = {stack_languages: THE_STACK_LANGUAGES, file_extensions: FILE_EXTENSIONS};
});

workerRouter.post("/worker/register", async (ctx) => {
	const body = validate(
		z.object({
			// max 8 printable ASCII characters
			node_name: z.string().min(1).max(8).regex(/^[\x20-\x7E]+$/, "node_name must contain only printable ASCII characters"),
			// exactly 8 printable ASCII characters
			node_hash: z.string().length(8).regex(/^[\x20-\x7E]{8}$/, "node_hash must be exactly 8 printable ASCII characters"),
			n_threads: z.number().int().min(1),
			n_threads_phase1: z.number().int().min(1).optional(),
			n_threads_phase2: z.number().int().min(1).optional(),
		}),
		ctx.request.body,
	);
	const {node_name, node_hash, n_threads} = body;
	const n1 = body.n_threads_phase1 ?? n_threads;
	const n2 = body.n_threads_phase2 ?? n_threads;

	const isRegistered = await redis.sIsMember(K.registered_node_names, node_name);

	if (isRegistered) {
		const storedHash = await redis.hGet(K.registered_node_hashes, node_name);
		if (storedHash !== node_hash) {
			warn(`[register] rejected: node_name '${node_name}' is already taken by another machine`);
			ctx.status = 409;
			ctx.body = {ok: false, reason: "name_taken"};
			return;
		}
		// Hash matches — crash recovery: return the previously assigned start_node_id
		const storedOffset = await redis.hGet(K.registered_node_offsets, node_name);
		const start_node_id = Number(storedOffset);
		const ids = Array.from({length: n_threads}, (_, i) => start_node_id + i);
		await Promise.all([
			...ids.map((id) => redis.hSet(K.node_stats(id), "node_name", node_name)),
			redis.sAdd(K.registered_node_ids, ids.map(String)),
			redis.hSet(K.registered_phase1_threads, node_name, String(n1)),
			redis.hSet(K.registered_phase2_threads, node_name, String(n2)),
		]);
		log(`[register] machine '${node_name}' re-registered (crash recovery) start_node_id=${start_node_id} node_ids [${ids.join(", ")}] phase1=${n1} phase2=${n2}`);
		ctx.body = {ok: true, start_node_id};
		return;
	}

	// Atomically allocate n_threads consecutive globally-unique node_ids
	const nextEnd = await redis.incrBy(K.registered_next_node_id, n_threads);
	const start_node_id = nextEnd - n_threads + 1;
	const ids = Array.from({length: n_threads}, (_, i) => start_node_id + i);

	await Promise.all([
		redis.sAdd(K.registered_node_names, node_name),
		redis.hSet(K.registered_node_hashes, node_name, node_hash),
		redis.hSet(K.registered_node_offsets, node_name, String(start_node_id)),
		redis.hSet(K.registered_phase1_threads, node_name, String(n1)),
		redis.hSet(K.registered_phase2_threads, node_name, String(n2)),
		...ids.map((id) => redis.hSet(K.node_stats(id), "node_name", node_name)),
		redis.sAdd(K.registered_node_ids, ids.map(String)),
	]);
	log(`[register] machine '${node_name}' registered with ${n_threads} thread(s): start_node_id=${start_node_id} node_ids [${ids.join(", ")}] phase1=${n1} phase2=${n2}`);
	ctx.body = {ok: true, start_node_id};
});

workerRouter.post("/heartbeat", async (ctx) => {
	const body = validate(
		z.object({
			node_id: z.number(),
			current_stack: z.string().optional(),
			stack_scanned: z.number().optional(),
			stack_samples: z.number().optional(),
			stack_total: z.number().nullable().optional(),
			worker_status: z.string().optional(),
		}),
		ctx.request.body,
	);
	const {node_id} = body;
	await redis.setEx(K.heartbeat(node_id), 300, "1");

	const updates: Record<string, string> = {last_heartbeat: String(Date.now())};
	if (body.current_stack !== undefined) updates.current_stack = body.current_stack;
	if (body.stack_scanned !== undefined) updates.stack_scanned = String(body.stack_scanned);
	if (body.stack_samples !== undefined) updates.stack_samples = String(body.stack_samples);
	if (body.stack_total != null) updates.stack_total = String(body.stack_total);
	if (body.worker_status !== undefined) updates.worker_status = body.worker_status;
	if (body.worker_status === "idle") updates.current_stack = "";
	await redis.hSet(K.node_stats(node_id), updates);
	ctx.body = {ok: true};
});
