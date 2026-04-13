import * as Sentry from "@sentry/node";
import Koa from "koa";
import bodyParser from "koa-bodyparser";

import {error} from "./logger.mjs";
import {dashboardRouter} from "./routes/dashboard.mjs";
import {fleetRouter} from "./routes/fleet.mjs";
import {mergeRouter} from "./routes/merge.mjs";
import {reposRouter} from "./routes/repos.mjs";
import {resetRouter} from "./routes/reset.mjs";
import {stackRouter} from "./routes/stack.mjs";
import {utilityRouter} from "./routes/utility.mjs";
import {workerRouter} from "./routes/worker.mjs";

const app = new Koa();

app.use(async (ctx, next) => {
	try {
		await next();
	} catch (err: any) {
		Sentry.captureException(err, {
			tags: {path: ctx.path, method: ctx.method},
			extra: {body: (ctx.request as any).body},
		});
		ctx.status = err.status ?? 500;
		ctx.body = {error: err.message ?? "Internal Server Error"};
		error(`[error] ${ctx.method} ${ctx.path}:`, err.message);
	}
});

app.use(bodyParser());

for (const router of [workerRouter, reposRouter, stackRouter, fleetRouter, mergeRouter, resetRouter, utilityRouter, dashboardRouter]) {
	app.use(router.routes());
	app.use(router.allowedMethods());
}

app.on("error", (err, ctx) => {
	Sentry.captureException(err, {extra: {path: ctx?.path}});
});

export default app;
