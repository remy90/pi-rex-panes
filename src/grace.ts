export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface GraceTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const timers: GraceTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function withinGrace(
	work: PromiseLike<unknown>,
	ms = DEFAULT_SHUTDOWN_GRACE_MS,
	clock: GraceTimers = timers,
): Promise<void> {
	let timer: unknown;
	try {
		await Promise.race([
			work,
			new Promise<void>((resolve) => { timer = clock.setTimeout(resolve, ms); }),
		]);
	} finally {
		if (timer !== undefined) clock.clearTimeout(timer);
	}
}
