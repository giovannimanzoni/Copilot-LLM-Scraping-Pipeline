import Router from "@koa/router";
import {readFileSync} from "fs";

import {getRedisData, getStatusData} from "../status.mjs";

export const dashboardRouter: Router = new Router();

dashboardRouter.get("/health", (ctx) => {
	ctx.body = {ok: true, ts: Date.now()};
});

dashboardRouter.get("/status", async (ctx) => {
	ctx.body = await getStatusData();
});

dashboardRouter.get("/", (ctx) => {
	ctx.type = "html";
	ctx.body = readFileSync("./src/dashboard.html", "utf-8");
});

dashboardRouter.get("/redis", (ctx) => {
	ctx.type = "html";
	ctx.body = readFileSync("./src/redis-dashboard.html", "utf-8");
});

dashboardRouter.get("/reset", (ctx) => {
	ctx.type = "html";
	ctx.body = readFileSync("./src/reset-dashboard.html", "utf-8");
});

dashboardRouter.get("/queries-gen", (ctx) => {
	ctx.type = "html";
	ctx.body = readFileSync("./src/queries-generator.html", "utf-8");
});

// Static CSS/JS assets for dashboards
dashboardRouter.get("/static/common.css", (ctx) => {
	ctx.type = "text/css";
	ctx.body = readFileSync("./src/static/common.css", "utf-8");
});

dashboardRouter.get("/static/dashboard.css", (ctx) => {
	ctx.type = "text/css";
	ctx.body = readFileSync("./src/static/dashboard.css", "utf-8");
});

dashboardRouter.get("/static/dashboard.js", (ctx) => {
	ctx.type = "application/javascript";
	ctx.set("Cache-Control", "no-store");
	ctx.body = readFileSync("./src/static/dashboard.js", "utf-8");
});

dashboardRouter.get("/static/redis-dashboard.css", (ctx) => {
	ctx.type = "text/css";
	ctx.body = readFileSync("./src/static/redis-dashboard.css", "utf-8");
});

dashboardRouter.get("/static/redis-dashboard.js", (ctx) => {
	ctx.type = "application/javascript";
	ctx.set("Cache-Control", "no-store");
	ctx.body = readFileSync("./src/static/redis-dashboard.js", "utf-8");
});

dashboardRouter.get("/static/reset-dashboard.css", (ctx) => {
	ctx.type = "text/css";
	ctx.body = readFileSync("./src/static/reset-dashboard.css", "utf-8");
});

dashboardRouter.get("/static/reset-dashboard.js", (ctx) => {
	ctx.type = "application/javascript";
	ctx.set("Cache-Control", "no-store");
	ctx.body = readFileSync("./src/static/reset-dashboard.js", "utf-8");
});

dashboardRouter.get("/static/theme.js", (ctx) => {
	ctx.type = "application/javascript";
	ctx.body = readFileSync("./src/static/theme.js", "utf-8");
});

dashboardRouter.get("/static/queries-generator.css", (ctx) => {
	ctx.type = "text/css";
	ctx.body = readFileSync("./src/static/queries-generator.css", "utf-8");
});

dashboardRouter.get("/static/queries-generator.js", (ctx) => {
	ctx.type = "application/javascript";
	ctx.set("Cache-Control", "no-store");
	ctx.body = readFileSync("./src/static/queries-generator.js", "utf-8");
});

dashboardRouter.get("/redis/data", async (ctx) => {
	ctx.body = await getRedisData();
});

dashboardRouter.get("/redis/events", async (ctx) => {
	ctx.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	ctx.status = 200;
	ctx.respond = false;

	const res = ctx.res;
	res.write("retry: 3000\n\n");

	let timeoutId: NodeJS.Timeout | null = null;

	const cleanup = () => {
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if (!res.writableEnded) res.end();
	};

	// Use a recursive setTimeout instead of setInterval so a slow getRedisData()
	// call (many Redis round-trips) never stacks up concurrent pushes that each
	// hold a large result object in memory.
	const push = async () => {
		try {
			const data = await getRedisData();
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch { /* ignore */ }
		if (!res.writableEnded) {
			timeoutId = setTimeout(push, 5000);
		}
	};

	await push();

	ctx.req.on("close", cleanup);
	res.on("error", cleanup);
});

dashboardRouter.get("/events", async (ctx) => {
	ctx.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	ctx.status = 200;
	ctx.respond = false;

	const res = ctx.res;
	res.write("retry: 2000\n\n");

	let timeoutId: NodeJS.Timeout | null = null;

	const cleanup = () => {
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if (!res.writableEnded) res.end();
	};

	// Use a recursive setTimeout instead of setInterval so a slow getStatusData()
	// call (35 Redis round-trips) never stacks up concurrent pushes that each
	// hold a large result object in memory.
	const push = async () => {
		try {
			const data = await getStatusData();
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch { /* ignore */ }
		if (!res.writableEnded) {
			timeoutId = setTimeout(push, 2000);
		}
	};

	await push();

	ctx.req.on("close", cleanup);
	res.on("error", cleanup);
});
