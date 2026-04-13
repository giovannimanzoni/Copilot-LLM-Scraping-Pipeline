import 'dotenv/config'

import * as Sentry from '@sentry/node'
import * as https from 'https'

// Disable cert verification for bugsink.lan (internal Sentry-compatible instance)
const insecureHttpsModule = {
	...https,
	request: (options: any, callback: any) => {
		options.rejectUnauthorized = false
		return https.request(options, callback)
	}
}

Sentry.init({
	dsn: process.env.SENTRY_DSN,
	environment: process.env.SENTRY_ENVIRONMENT ?? "production",
	release: "coordinator@1.0.0",
	tracesSampleRate: 1.0,
	profilesSampleRate: 1.0,
	transportOptions: {
		httpModule: insecureHttpsModule
	}
})
