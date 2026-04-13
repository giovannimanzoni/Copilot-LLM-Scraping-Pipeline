import Router from "@koa/router";
import {z} from "zod";

import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {validate} from "../validate.mjs";

export const stackRouter: Router = new Router();

stackRouter.get("/stack/next/:nodeId", async (ctx) => {
	const nodeId = parseInt(ctx.params.nodeId);
	if (isNaN(nodeId)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeId"};
		return;
	}

	const stackEnabled = (await redis.get(K.fleet_stack_enabled) ?? "1") === "1";
	if (!stackEnabled) {
		ctx.body = {task: null};
		return;
	}

	const taskStr = await redis.lPop(K.stack_pending);
	if (taskStr) {
		const task = JSON.parse(taskStr);
		const taskKey = `${task.lang}:${task.batch_index}`;
		await redis.zAdd(K.stack_assigned, {score: Date.now() / 1000, value: taskKey});
		await redis.hSet(K.stack_assigned_tasks, taskKey, taskStr);
		ctx.body = {task};
	} else {
		ctx.body = {task: null};
	}
});

stackRouter.post("/stack/done", async (ctx) => {
	const {lang, batch_index, node_id, samples} = validate(
		z.object({lang: z.string(), batch_index: z.number(), node_id: z.number(), samples: z.number()}),
		ctx.request.body,
	);
	const taskKey = `${lang}:${batch_index}`;
	await redis.zRem(K.stack_assigned, taskKey);
	await redis.hDel(K.stack_assigned_tasks, taskKey);
	await redis.sRem(K.stack_problematic, taskKey);
	await redis.hDel(K.stack_problematic_tasks, taskKey);
	await redis.sAdd(K.stack_done, taskKey);
	await redis.hIncrBy(K.node_stats(node_id), "stack_samples_done", samples);
	ctx.body = {ok: true};
});
