import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tailReport } from "./report-tail.ts";

test.each([false, true])("tailer drains final lines when the child exits, settled present: %s", async (settled) => {
	const dir = mkdtempSync(join(tmpdir(), "tail-exit-"));
	const file = join(dir, "report");
	writeFileSync(file, "");
	const lines: string[] = [];
	try {
		const result = await tailReport({ file, pollMs: 1000, processLine: (line) => lines.push(line), waitForExit: async () => {
			appendFileSync(file, '{"type":"message_end"}\n');
			if (settled) appendFileSync(file, '{"type":"agent_settled"}\n');
		} });
		expect(result.settled).toBe(settled);
		expect(result.aborted).toBe(false);
		expect(lines[0]).toBe('{"type":"message_end"}');
		if (!settled) expect(result.error?.message).toContain("before agent_settled");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("abort stops the tailer and its wait process", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tail-abort-"));
	const file = join(dir, "report");
	writeFileSync(file, "");
	const controller = new AbortController();
	let waitSignal: AbortSignal | undefined;
	try {
		const pending = tailReport({ file, signal: controller.signal, processLine() {}, waitForExit: (signal) => {
			waitSignal = signal;
			return new Promise(() => {});
		} });
		controller.abort();
		expect(await pending).toEqual({ settled: false, aborted: true });
		expect(waitSignal?.aborted).toBe(true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tailer buffers partial lines and UTF-8, feeds processLine, then cancels wait on settled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tail-test-"));
	const file = join(dir, "report");
	writeFileSync(file, "");
	const lines: string[] = [];
	let waitSignal: AbortSignal | undefined;
	try {
		const pending = tailReport({ file, pollMs: 2, processLine: (line) => lines.push(line), waitForExit: (signal) => {
			waitSignal = signal;
			return new Promise(() => {});
		} });
		const record = Buffer.from('{"type":"message_end","text":"🌲"}\n');
		const split = record.indexOf(Buffer.from("🌲")) + 2;
		appendFileSync(file, record.subarray(0, split));
		await Bun.sleep(15);
		expect(lines).toEqual([]);
		appendFileSync(file, record.subarray(split));
		appendFileSync(file, '{"type":"agent_settled"}\n{"ignored":true}\n');
		expect(await pending).toEqual({ settled: true, aborted: false });
		expect(lines).toEqual(['{"type":"message_end","text":"🌲"}', '{"type":"agent_settled"}']);
		expect(waitSignal?.aborted).toBe(true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
