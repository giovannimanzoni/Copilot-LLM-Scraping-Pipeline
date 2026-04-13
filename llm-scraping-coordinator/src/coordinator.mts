import * as Sentry from "@sentry/node";

import app from "./app.mjs";
import {PORT} from "./config.mjs";
import {initRedis} from "./init.mjs";
import {error, log} from "./logger.mjs";
import {redisClient as redis} from "./redis.mjs";
import {startWatchdog} from "./watchdog.mjs";

await initRedis();
startWatchdog();

const server = app.listen(PORT, "0.0.0.0", () => {
	log(`[coordinator] http://0.0.0.0:${PORT} — workers dynamic (register on connect)`);
});

// Disable request timeout — large zip uploads (final dataset ~25+ GB) take longer than
// the Node.js 18+ default of 300 s, causing premature 408 aborts.
server.requestTimeout = 0;

process.on("SIGTERM", async () => {
	log("[coordinator] SIGTERM received, shutting down...");
	await Sentry.flush(2000);
	server.close();
	await redis.quit();
	process.exit(0);
});

process.on("uncaughtException", (err) => {
	Sentry.captureException(err, {tags: {type: "uncaughtException"}});
	error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
	Sentry.captureException(reason, {tags: {type: "unhandledRejection"}});
	error("[unhandledRejection]", reason);
});
