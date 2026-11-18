import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_START_TIMEOUT_MS = 60_000;

export function isFailureStopReason(reason: unknown): boolean {
	return reason === "error" || reason === "aborted";
}

export interface ReportEvent {
	type?: string;
	message?: { role?: string; stopReason?: unknown };
}

export interface ReportOutcome {
	settled: boolean;
	aborted: boolean;
	error?: Error;
}

export function tailReport(options: {
	file: string;
	processLine: (line: string, event?: ReportEvent) => void;
	waitForExit: (signal: AbortSignal) => Promise<unknown>;
	signal?: AbortSignal;
	pollMs?: number;
	startTimeoutMs?: number;
}): Promise<ReportOutcome> {
	return new Promise((resolve) => {
		const waitController = new AbortController();
		let done = false;
		let fd: number | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		let started = false;
		let offset = 0;
		let pending = "";
		const decoder = new StringDecoder("utf8");
		const bytes = Buffer.alloc(64 * 1024);
		const finish = (outcome: ReportOutcome) => {
			if (done) return;
			done = true;
			if (timer) clearInterval(timer);
			if (startTimer) clearTimeout(startTimer);
			options.signal?.removeEventListener("abort", abort);
			waitController.abort();
			if (fd !== undefined) closeSync(fd);
			resolve(outcome);
		};
		const abort = () => finish({ settled: false, aborted: true });
		const line = (value: string) => {
			if (done || !value.trim()) return;
			let event: ReportEvent | undefined;
			try { event = JSON.parse(value) ?? undefined; }
			catch { /* Ignore incomplete or unrelated records. */ }
			options.processLine(value, event);
			if (event?.type === "agent_start") {
				started = true;
				if (startTimer) clearTimeout(startTimer);
			}
			if (event?.type === "agent_settled") finish({ settled: true, aborted: false });
		};
		const drain = (final = false) => {
			if (done || fd === undefined) return;
			let count: number;
			while (!done && (count = readSync(fd, bytes, 0, bytes.length, offset)) > 0) {
				offset += count;
				pending += decoder.write(bytes.subarray(0, count));
				let newline: number;
				while (!done && (newline = pending.indexOf("\n")) !== -1) {
					const record = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					line(record);
				}
			}
			if (final && !done) line(pending + decoder.end());
		};
		const exited = (error?: unknown) => {
			if (done) return;
			try { drain(true); } catch (readError) { error = readError; }
			if (!done) finish({
				settled: false, aborted: false,
				error: new Error(`Pane exited before agent_settled${error ? `: ${String(error)}` : ""}`),
			});
		};
		if (options.signal?.aborted) { abort(); return; }
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			fd = openSync(options.file, "r");
			options.waitForExit(waitController.signal).then(() => exited(), exited);
			drain();
			if (!done) timer = setInterval(() => {
				try { drain(); } catch (error) { exited(error); }
			}, options.pollMs ?? 50);
			if (!done && !started) {
				const timeout = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
				startTimer = setTimeout(() => {
					try { drain(); } catch (error) { exited(error); }
					if (!done && !started) finish({
						settled: false, aborted: false,
						error: new Error(`No agent_start within ${timeout} ms. Pane stays open for inspection. Configure PI_REX_PANES_START_TIMEOUT_MS to allow more startup time.`),
					});
				}, timeout);
			}
		} catch (error) { exited(error); }
	});
}
