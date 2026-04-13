import Router from "@koa/router";
import * as Sentry from "@sentry/node";
import {z} from "zod";

import {log, warn} from "../logger.mjs";
import {redisClient as redis} from "../redis.mjs";
import {K} from "../redis-keys.mjs";
import {validate} from "../validate.mjs";

/**
 * If a sequential repo retry is in progress and the given repo matches the active slot,
 * clear the slot and dispatch the next repo from the retry queue into pending.
 */
export async function advanceRetryQueue(completedRepo: string): Promise<void> {
	const active = await redis.get(K.repos_retry_active);
	if (active !== completedRepo) return;

	await redis.del(K.repos_retry_active);

	const next = await redis.lPop(K.repos_retry_queue);
	if (next) {
		await redis.sAdd(K.repos_pending, next);
		await redis.set(K.repos_retry_active, next);
		log(`[retry] dispatched next repo: ${next}`);
	} else {
		log("[retry] retry queue exhausted");
	}
}

export const reposRouter: Router = new Router();

reposRouter.post("/repos/register", async (ctx) => {
	const {repos, node_id} = validate(
		z.object({repos: z.array(z.string()), node_id: z.number()}),
		ctx.request.body,
	);

	let added = 0;
	for (const repo of repos) {
		const [inDone, inAssigned] = await Promise.all([
			redis.sIsMember(K.repos_done, repo),
			redis.zScore(K.repos_assigned, repo),
		]);
		if (!inDone && inAssigned === null) {
			await redis.sAdd(K.repos_pending, repo);
			added++;
		}
	}
	await redis.hIncrBy(K.node_stats(node_id), "repos_registered", added);
	ctx.body = {added};
});

reposRouter.get("/repos/next/:nodeId", async (ctx) => {
	const nodeId = parseInt(ctx.params.nodeId);
	if (isNaN(nodeId)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeId"};
		return;
	}

	const githubEnabled = (await redis.get(K.fleet_repos_enabled) ?? "1") === "1";
	if (!githubEnabled) {
		ctx.body = {repo: null};
		return;
	}
	const [repo] = await redis.sPopCount(K.repos_pending, 1);
	if (repo) {
		await redis.zAdd(K.repos_assigned, {score: Date.now() / 1000, value: repo});
		await redis.hSet(K.node_stats(nodeId), "current_repo", repo);
	}
	ctx.body = {repo: repo ?? null};
});

reposRouter.get("/repos/batch/:nodeId", async (ctx) => {
	const nodeId = parseInt(ctx.params.nodeId);
	if (isNaN(nodeId)) {
		ctx.status = 400;
		ctx.body = {error: "invalid nodeId"};
		return;
	}

	const githubEnabled = (await redis.get(K.fleet_repos_enabled) ?? "1") === "1";
	if (!githubEnabled) {
		ctx.body = {repos: []};
		return;
	}
	const repos = await redis.sPopCount(K.repos_pending, 100);
	if (repos.length > 0) {
		const score = Date.now() / 1000;
		await Promise.all(repos.map((repo) => redis.zAdd(K.repos_assigned, {score, value: repo})));
	}
	ctx.body = {repos};
});

reposRouter.post("/repos/done", async (ctx) => {
	const {repo, node_id, samples} = validate(
		z.object({repo: z.string(), node_id: z.number(), samples: z.number()}),
		ctx.request.body,
	);
	await redis.zRem(K.repos_assigned, repo);
	await redis.sAdd(K.repos_done, repo);
	await redis.hIncrBy(K.node_stats(node_id), "repos_done", 1);
	await redis.hIncrBy(K.node_stats(node_id), "samples_collected", samples);
	await redis.hSet(K.node_stats(node_id), "current_repo", "");
	await advanceRetryQueue(repo);
	ctx.body = {ok: true};
});

reposRouter.post("/repos/fail", async (ctx) => {
	const {repo, node_id, reason} = validate(
		z.object({repo: z.string(), node_id: z.number(), reason: z.string()}),
		ctx.request.body,
	);
	await redis.zRem(K.repos_assigned, repo);

	const isNotFound = reason.includes("not found");
	if (isNotFound) {
		await redis.sAdd(K.repos_cancelled, repo);
		warn(`[cancelled] ${repo} da nodo ${node_id}: ${reason}`);
	} else {
		await redis.sAdd(K.repos_problematic, repo);
		await redis.hIncrBy(K.node_stats(node_id), "repos_failed", 1);
		Sentry.captureMessage(`Repo fail: ${repo}`, {
			level: "warning",
			tags: {component: "worker", node_id: String(node_id)},
			extra: {reason},
		});
		warn(`[fail] ${repo} da nodo ${node_id}: ${reason}`);
	}
	await advanceRetryQueue(repo);
	ctx.body = {ok: true};
});
