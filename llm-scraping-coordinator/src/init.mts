import {readFileSync} from "node:fs";
import {resolve} from "node:path";

import * as Sentry from "@sentry/node";

import {STACK_TASKS} from "./config.mjs";
import {log, warn} from "./logger.mjs";
import {redisClient as redis, RedisConnect} from "./redis.mjs";
import {K} from "./redis-keys.mjs";
import {seedStackTasks} from "./stack-seeder.mjs";
import {recoverTimedOutRepos} from "./watchdog.mjs";

const REPOS_FILE = resolve(process.cwd(), "input_data/repos_found.txt");

function loadReposFile(): string[] {
	try {
		const content = readFileSync(REPOS_FILE, "utf8");
		return content.split("\n").map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export async function initRedis(): Promise<void> {
	await RedisConnect();

	return await Sentry.startSpan({name: "coordinator.initRedis"}, async () => {
		// Seed repos from repos_found.txt if available
		const repos = loadReposFile();
		if (repos.length === 0) {
			warn("[init] input_data/repos_found.txt is missing or empty — use the Repo Scanner (/queries-gen) to populate it before starting phase 1");
		} else {
			const [reposPending, reposDone] = await Promise.all([
				redis.sCard(K.repos_pending),
				redis.sCard(K.repos_done),
			]);
			if (reposPending === 0 && reposDone === 0) {
				const BATCH = 1000;
				for (let i = 0; i < repos.length; i += BATCH) {
					await redis.sAdd(K.repos_pending, repos.slice(i, i + BATCH));
				}
				log(`[init] ${repos.length} repos seeded from repos_found.txt`);
			} else {
				log(`[init] repos: ${reposPending} pending, ${reposDone} done`);
			}
		}

		const stackLen = await redis.lLen(K.stack_pending);
		const stackDone = await redis.sCard(K.stack_done);
		if (stackLen === 0 && stackDone === 0) {
			const seeded = await seedStackTasks();
			log(`[init] ${seeded} stack tasks loaded`);
		} else {
			log(`[init] stack: ${stackLen} pending, ${stackDone} done`);
		}

		await purgeStaleStackLangs();
		await recoverTimedOutRepos();
		log("[init] Redis ready");
	});
}

async function purgeStaleStackLangs(): Promise<void> {
	const validLangs = new Set<string>(STACK_TASKS.map(t => t.lang));

	const assigned = await redis.zRange(K.stack_assigned, 0, -1);
	for (const key of assigned) {
		const lang = key.split(":")[0];
		if (!validLangs.has(lang)) {
			await redis.zRem(K.stack_assigned, key);
			await redis.hDel(K.stack_assigned_tasks, key);
			log(`[init] removed stale stack task (assigned): ${key}`);
		}
	}

	const problematic = await redis.sMembers(K.stack_problematic);
	for (const key of problematic) {
		const lang = key.split(":")[0];
		if (!validLangs.has(lang)) {
			await redis.sRem(K.stack_problematic, key);
			await redis.hDel(K.stack_problematic_tasks, key);
			log(`[init] removed stale stack task (problematic): ${key}`);
		}
	}

	const pendingLen = await redis.lLen(K.stack_pending);
	if (pendingLen === 0) return;

	const all = await redis.lRange(K.stack_pending, 0, -1);
	const valid = all.filter((taskStr: string) => {
		try {
			return validLangs.has(JSON.parse(taskStr).lang);
		} catch {
			return false;
		}
	});
	const staleCount = all.length - valid.length;
	if (staleCount > 0) {
		await redis.del(K.stack_pending);
		if (valid.length > 0) await redis.rPush(K.stack_pending, valid);
		log(`[init] removed ${staleCount} stale stack tasks (pending)`);
	}
}
