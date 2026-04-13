import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";

import Router from "@koa/router";
import {z} from "zod";

export const utilityRouter: Router = new Router();

interface GithubRepo {
	full_name: string;
	stargazers_count: number;
}

interface GithubSearchResult {
	items: GithubRepo[];
	total_count: number;
	message?: string;
}

type EmitFn = (event: string, data: unknown) => void;

const REPOS_FILE = resolve(process.cwd(), "input_data/repos_found.txt");

function githubHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "llm-scraping-coordinator",
	};
	if (process.env.GITHUB_TOKEN) {
		headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
	}
	return headers;
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

// Waits for `waitMs` while emitting countdown log lines every 5s so the SSE connection stays alive
async function rateLimitWait(waitMs: number, emit: EmitFn): Promise<void> {
	const TICK = 5_000;
	let remaining = waitMs;
	while (remaining > 0) {
		const chunk = Math.min(TICK, remaining);
		await sleep(chunk);
		remaining -= chunk;
		if (remaining > 0) {
			emit("log", {msg: `rate limit: resuming in ${Math.ceil(remaining / 1000)}s…`});
		}
	}
}

// Wraps fetch with automatic rate-limit waiting and error handling
async function githubFetch(url: string, headers: Record<string, string>, emit: EmitFn): Promise<GithubSearchResult> {
	for (;;) {
		const resp = await fetch(url, {headers});

		if (resp.status === 403 || resp.status === 429) {
			const resetHeader = resp.headers.get("X-RateLimit-Reset");
			const waitMs = resetHeader
				? Math.max(0, parseInt(resetHeader) * 1000 - Date.now()) + 2000
				: 60_000;
			emit("log", {msg: `rate limited — waiting ${Math.ceil(waitMs / 1000)}s for reset…`});
			await rateLimitWait(waitMs, emit);
			continue;
		}

		if (!resp.ok) {
			const body = await resp.text();
			throw Object.assign(new Error(`GitHub API error (${resp.status}): ${body}`), {status: resp.status});
		}

		const data = (await resp.json()) as GithubSearchResult;

		if (data.message?.toLowerCase().includes("rate limit")) {
			emit("log", {msg: `rate limited (message) — waiting 60s…`});
			await rateLimitWait(60_000, emit);
			continue;
		}
		if (data.message) {
			throw Object.assign(new Error(`GitHub API: ${data.message}`), {status: 422});
		}

		return data;
	}
}

const PAGE_SIZE = 100;
// GitHub hard-caps search results at 1000 per query (10 pages × 100)
const MAX_RESULTS_PER_RANGE = 1000;

// Fetch all pages for a specific star range and add repo full_names to the set
async function fetchPages(
	language: string,
	starsRange: string,
	headers: Record<string, string>,
	repos: Set<string>,
	emit: EmitFn,
): Promise<void> {
	const q = encodeURIComponent(`language:${language} stars:${starsRange}`);

	for (let page = 1; page <= 10; page++) {
		const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=asc&per_page=${PAGE_SIZE}&page=${page}`;
		const data = await githubFetch(url, headers, emit);

		const before = repos.size;
		for (const repo of data.items) {
			repos.add(repo.full_name);
		}
		emit("log", {msg: `  stars:${starsRange} p${page}: ${data.items.length} repos, +${repos.size - before} new (${repos.size} total)`});

		if (data.items.length < PAGE_SIZE) break;
	}
}

// Recursively bisect [low, high] until each sub-range has ≤ 1000 repos
async function fetchRange(
	language: string,
	low: number,
	high: number,
	headers: Record<string, string>,
	repos: Set<string>,
	emit: EmitFn,
): Promise<void> {
	const starsRange = `${low}..${high}`;
	const q = encodeURIComponent(`language:${language} stars:${starsRange}`);
	const probeUrl = `https://api.github.com/search/repositories?q=${q}&per_page=1&page=1`;
	const probe = await githubFetch(probeUrl, headers, emit);
	const total = probe.total_count;

	if (total === 0) return;

	if (total <= MAX_RESULTS_PER_RANGE) {
		emit("log", {msg: `stars:${starsRange} — ${total} repos`});
		await fetchPages(language, starsRange, headers, repos, emit);
		return;
	}

	// Too many results — bisect
	const mid = Math.floor((low + high) / 2);
	if (mid === low) {
		// Range is a single star value, can't split further
		emit("log", {msg: `stars:${starsRange} — ${total} repos (range indivisible, fetching first 1000)`});
		await fetchPages(language, starsRange, headers, repos, emit);
		return;
	}

	emit("log", {msg: `stars:${starsRange} — ${total} repos, bisecting at ${mid}…`});
	await fetchRange(language, low, mid, headers, repos, emit);
	await fetchRange(language, mid + 1, high, headers, repos, emit);
}

// SSE stream: scans GitHub repos via range bisection, writes full_name list to data/repos_found.txt
utilityRouter.get("/utility/repo-scanner/stream", async (ctx) => {
	const language = z.string().min(1).max(50).trim().parse(ctx.query["language"] ?? "typescript");
	const minStars = z.coerce.number().int().min(0).max(1_000_000).parse(ctx.query["minStars"] ?? "150");

	ctx.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	ctx.status = 200;
	ctx.respond = false;

	const res = ctx.res;
	const emit: EmitFn = (event, data) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// SSE comment sent every 15s to prevent proxy/browser connection timeouts during long waits
	const keepalive = setInterval(() => { res.write(": keepalive\n\n"); }, 15_000);

	try {
		const repos = new Set<string>();
		const headers = githubHeaders();
		const authenticated = !!process.env.GITHUB_TOKEN;

		emit("log", {msg: `scanning github: language=${language}, stars>=${minStars}`});
		emit("log", {msg: authenticated ? "authenticated (30 req/min)" : "unauthenticated (10 req/min) — add GITHUB_TOKEN for speed"});

		// Probe the full range: get total count AND discover the actual max star count
		const totalQ = encodeURIComponent(`language:${language} stars:>=${minStars}`);
		const totalProbe = await githubFetch(
			`https://api.github.com/search/repositories?q=${totalQ}&sort=stars&order=desc&per_page=1&page=1`,
			headers,
			emit,
		);
		const totalCount = totalProbe.total_count;
		const maxStars = totalProbe.items[0]?.stargazers_count ?? minStars;
		emit("log", {msg: `${totalCount} repos found — max stars: ${maxStars.toLocaleString()}`});
		emit("log", {msg: `scanning all via range bisection [${minStars}..${maxStars}]`});

		await fetchRange(language, minStars, maxStars, headers, repos, emit);

		emit("log", {msg: `done — ${repos.size} unique repos, writing to file…`});
		await mkdir(resolve(process.cwd(), "input_data"), {recursive: true});
		await writeFile(REPOS_FILE, [...repos].sort().join("\n") + "\n", "utf8");
		emit("log", {msg: `written to input_data/repos_found.txt`});
		emit("result", {count: repos.size});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "unknown error";
		emit("error", {msg});
	} finally {
		clearInterval(keepalive);
	}

	res.end();
});
