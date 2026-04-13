function ts(): string {
	const now = new Date();
	const y = now.getFullYear();
	const mo = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const mi = String(now.getMinutes()).padStart(2, "0");
	const s = String(now.getSeconds()).padStart(2, "0");
	const ms = String(now.getMilliseconds()).padStart(3, "0");
	return `${y}-${mo}-${d} ${h}:${mi}:${s},${ms}`;
}

export const log = (...args: unknown[]): void =>
	console.log(`${ts()} [INFO][coordinator]`, ...args);

export const warn = (...args: unknown[]): void =>
	console.warn(`${ts()} [WARN][coordinator]`, ...args);

export const error = (...args: unknown[]): void =>
	console.error(`${ts()} [ERROR][coordinator]`, ...args);
