export const PORT = 3981;
export const REPO_TIMEOUT_S = 30 * 60;
export const STACK_TIMEOUT_S = 45 * 60;

const _stackLangsEnv = process.env.THE_STACK_LANGUAGES ?? "typescript";
export const THE_STACK_LANGUAGES: readonly string[] = _stackLangsEnv
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

const _fileExtensionsEnv = process.env.FILE_EXTENSIONS ?? ".ts,.mts,.cts";
export const FILE_EXTENSIONS: readonly string[] = _fileExtensionsEnv
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

export const STACK_TASKS = [
	{lang: "typescript", data_dir: "data/typescript", target_lang: "typescript"},
] as const;
