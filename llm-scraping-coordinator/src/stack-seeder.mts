import {STACK_TASKS} from "./config.mjs";
import {log} from "./logger.mjs";
import {redisClient as redis} from "./redis.mjs";
import {K} from "./redis-keys.mjs";

export async function fetchHFDatasetFiles(
	dataset: string,
	revision: string,
	dirPath: string,
	token?: string | null,
): Promise<string[]> {
	const url = `https://huggingface.co/api/datasets/${dataset}/tree/${revision}/${dirPath}`;
	const headers: Record<string, string> = {};
	if (token) headers["Authorization"] = `Bearer ${token}`;
	const resp = await fetch(url, {headers, signal: AbortSignal.timeout(15_000)});
	if (!resp.ok) throw new Error(`HF Hub API → ${resp.status}`);
	const items = await resp.json() as Array<{path: string; type: string}>;
	return items
		.filter((f) => f.type === "file" && f.path.endsWith(".parquet"))
		.map((f) => f.path)
		.sort();
}

export async function seedStackTasks(preserveDone = false): Promise<number> {
	const shardFiles = await fetchHFDatasetFiles(
		"bigcode/the-stack", "main", "data/typescript", process.env.HF_TOKEN,
	);
	log(`[seed] HF API: ${shardFiles.length} shard files found`);

	let seeded = 0;
	for (const task of STACK_TASKS) {
		for (let i = 0; i < shardFiles.length; i++) {
			const taskKey = `${task.lang}:${i}`;
			if (preserveDone && await redis.sIsMember(K.stack_done, taskKey)) continue;
			const taskStr = JSON.stringify({
				...task,
				data_files: shardFiles[i],
				batch_index: i,
				total_batches: shardFiles.length,
			});
			await redis.rPush(K.stack_pending, taskStr);
			seeded++;
		}
	}
	return seeded;
}
