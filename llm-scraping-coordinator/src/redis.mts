import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import {createClient, createCluster} from 'redis'

dotenv.config()

export const redisClient = process.env.REDIS_IS_CLUSTER === '1'
	? createCluster({
		rootNodes: [
			{url: `redis://${process.env.REDIS_DB1_HOST}:${process.env.REDIS_DB1_PORT}`},
			{url: `redis://${process.env.REDIS_DB2_HOST}:${process.env.REDIS_DB2_PORT}`},
			{url: `redis://${process.env.REDIS_DB3_HOST}:${process.env.REDIS_DB3_PORT}`}
		],
		defaults: {
			username: process.env.REDIS_USERNAME,
			password: process.env.REDIS_PASSWORD
		}
	})
	: createClient({url: process.env.REDIS_URL})

export const RedisConnect = async () => {
	console.info('[Redis] Try connect to database... ')

	redisClient.on('error', e => {
		console.error('Redis Client Error')
		Sentry.captureException(e)
	})
	await redisClient.connect()
	console.info(
		'[Redis] OK: Redis connection has been established successfully. '
	)
}

export async function RedisDisconnect() {
	console.info('[Redis] Try close connection to database... ')
	try {
		await redisClient.quit() // Gracefully close a client's connection to Redis
		console.info('[Redis] OK: Redis connection has been closed successfully.')
	} catch (e) {
		if (e instanceof Error && e.message === 'The client is closed') {
			console.info('[Redis] Client was already closed')
			return // Continue execution if client is already closed
		}
		// For any other errors, log and re-throw
		console.error('[Redis] Error during disconnection')
		Sentry.captureException(e)
		throw e
	}
}
