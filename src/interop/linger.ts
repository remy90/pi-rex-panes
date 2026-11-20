export interface LingerTimers {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const defaultTimers: LingerTimers = {
	now: () => Date.now(),
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const UNFOCUSED_CLOSE_MS = 30_000;
const FOCUS_POLL_MS = 5_000;

export function scheduleLinger(options: {
	delayMs: number;
	timers?: LingerTimers;
	isFocused(): Promise<boolean>;
	close(): void;
}): () => void {
	const timers = options.timers ?? defaultTimers;
	let timer: unknown;
	let stopped = false;
	const cancel = () => {
		stopped = true;
		if (timer !== undefined) timers.clearTimeout(timer);
	};
	const close = () => { cancel(); options.close(); };
	if (options.delayMs === 0) {
		close();
		return cancel;
	}
	let postponed = false;
	let unfocusedSince: number | undefined;
	const check = async () => {
		const focused = await options.isFocused().catch(() => false);
		if (stopped) return;
		if (focused) {
			postponed = true;
			unfocusedSince = undefined;
		} else {
			unfocusedSince ??= timers.now();
			if (!postponed || timers.now() - unfocusedSince >= UNFOCUSED_CLOSE_MS) {
				close();
				return;
			}
		}
		timer = timers.setTimeout(() => { void check(); }, FOCUS_POLL_MS);
	};
	timer = timers.setTimeout(() => { void check(); }, options.delayMs);
	return cancel;
}
