import {z} from "zod";

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		const err: any = new Error(result.error.issues.map((i) => i.message).join(", "));
		err.status = 400;
		throw err;
	}
	return result.data;
}
