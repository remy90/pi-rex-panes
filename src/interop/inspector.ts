import { createRexClient, runCommand, type Runner } from "../rex/client.ts";
import { findRex } from "../rex/lookup.ts";
import { createPlacement } from "../rex/placement.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPORT_FLAG } from "../reporter.ts";
import {
	INSPECTOR_REGISTER_EVENT,
	type InspectorContext,
	type InspectorPlugin,
	type InspectorResult,
	type InspectorRegistration,
	type InspectorRegistrationRequest,
} from "./types.ts";

interface InspectorDeps {
	log?: (message: string) => void;
	shutdownGraceMs?: number;
	lookup?: (env: NodeJS.ProcessEnv) => string | undefined;
	runner?: Runner;
}

export function registerInspector(pi: ExtensionAPI, deps: InspectorDeps = {}) {
	const inspector = createInspector(deps);
	let registration: InspectorRegistration | undefined;
	let logged = false;
	pi.on("session_start", () => {
		registration?.dispose();
		registration = undefined;
		if (pi.getFlag(REPORT_FLAG)) return;
		const request: InspectorRegistrationRequest = { version: 1, plugin: inspector.plugin };
		pi.events.emit(INSPECTOR_REGISTER_EVENT, request);
		if (request.result?.ok) registration = request.result.registration;
		else if (request.result && !logged) {
			logged = true;
			(deps.log ?? console.warn)(`pi-rex-panes inspector registration failed: ${request.result.error.message}`);
		}
	});
	let closing: Promise<void> | undefined;
	return {
		registered: () => registration !== undefined,
		shutdown() {
			if (closing) return closing;
			const current = registration;
			registration = undefined;
			return closing = (async () => {
				try { current?.dispose(); } finally { await inspector.shutdown(); }
			})();
		},
	};
}

function result(text: string, isError = false): InspectorResult {
	return { content: [{ type: "text", text }], details: { mode: "management", results: [] }, isError };
}

export function createInspector(deps: InspectorDeps = {}) {
	const lookup = deps.lookup ?? findRex;
	const runner = deps.runner ?? runCommand;
	const panes = new Map<string, string>();
	const opening = new Map<string, Promise<InspectorResult>>();
	const shutdownSignal = new AbortController();
	const key = (ctx: InspectorContext) => JSON.stringify([ctx.target.runId, ctx.target.index ?? null]);
	let connection: {
		binary: string;
		session: string;
		rex: ReturnType<typeof createRexClient>;
		placement: ReturnType<typeof createPlacement>;
	} | undefined;
	const connect = (ctx: InspectorContext) => {
		if (connection) return connection;
		const binary = lookup(ctx.env);
		if (!binary || !ctx.env.REX_SESSION || !ctx.env.REX_BLOCK) throw new Error("Rex inspector is unavailable");
		const rex = createRexClient(binary, ctx.env.REX_SESSION, runner);
		return connection = {
			binary, session: ctx.env.REX_SESSION, rex, placement: createPlacement(rex, ctx.env.REX_BLOCK),
		};
	};
	const plugin: InspectorPlugin = {
		name: "rex-panes",
		available: (ctx) => Boolean(ctx.env.REX_SESSION && ctx.env.REX_BLOCK && lookup(ctx.env)),
		owns: (ctx) => panes.has(key(ctx)),
		async open(ctx, launch, params) {
			const existing = opening.get(key(ctx));
			if (existing) return existing;
			const operation = (async () => {
				try {
					shutdownSignal.signal.throwIfAborted();
					const { rex, placement, binary, session } = connect(ctx);
					let id = panes.get(key(ctx));
					if (id) {
						let live = (await rex.listPaneIds()).has(id);
						if (live) {
							try {
								const state = await runner(binary, [
									"--autostart=false", "--timeout", "3s", "block", "call", "-s", session, "-b", id, "process",
								]);
								const exit = state.code === 0 ? JSON.parse(state.stdout)?.last_exit?.exit_code : undefined;
								if (Number.isInteger(exit)) {
									const closed = await plugin.close!(ctx);
									if (closed.isError) return closed;
									live = false;
								}
							} catch { /* Preserve a pane whose process state cannot be read. */ }
						}
						if (!live) {
							placement.forget(id);
							panes.delete(key(ctx));
							id = undefined;
						}
					}
					id ??= await placement.open({
						label: `pi-inspector-${ctx.target.runId}`, cwd: ctx.target.status.cwd ?? ctx.cwd,
						argv: [launch.executable, ...launch.argv],
					}, ctx.signal ? AbortSignal.any([ctx.signal, shutdownSignal.signal]) : shutdownSignal.signal);
					panes.set(key(ctx), id);
					if (params.focus) {
						try {
							await runner(binary, ["--autostart=false", "--timeout", "3s", "block", "focus", id, "-s", session]);
						} catch { /* The inspector remains open when focus fails. */ }
					}
					return result(`Opened Rex inspector ${id}.`);
				} catch (error) { return result(String(error), true); }
			})();
			opening.set(key(ctx), operation);
			try { return await operation; } finally { opening.delete(key(ctx)); }
		},
		async status(ctx) {
			const id = panes.get(key(ctx));
			if (!id) return result("Rex inspector is closed.");
			try {
				if ((await connection!.rex.listPaneIds()).has(id)) return result(`Rex inspector ${id} is open.`);
				connection!.placement.forget(id);
				panes.delete(key(ctx));
				return result("Rex inspector is closed.");
			} catch (error) { return result(String(error), true); }
		},
		async close(ctx) {
			const id = panes.get(key(ctx));
			if (!id) return result("Rex inspector is closed.");
			try {
				const closed = await connection!.rex.closePane(id);
				if (closed.code !== 0 && (await connection!.rex.listPaneIds()).has(id)) {
					return result(closed.stderr || `Could not close Rex inspector ${id}.`, true);
				}
				connection!.placement.forget(id);
				panes.delete(key(ctx));
				return result(`Closed Rex inspector ${id}. The run continues.`);
			} catch (error) { return result(String(error), true); }
		},
	};
	let stopping: Promise<void> | undefined;
	return {
		plugin,
		shutdown() {
			if (stopping) return stopping;
			shutdownSignal.abort();
			const cleanup = async () => {
				await Promise.allSettled([...opening.values()]);
				await Promise.allSettled([...panes].map(async ([target, id]) => {
					const closed = await connection!.rex.closePane(id);
					if (closed.code !== 0) throw new Error(closed.stderr || `Could not close Rex inspector ${id}`);
					connection!.placement.forget(id);
					panes.delete(target);
				}));
			};
			return stopping = (async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						cleanup(),
						new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.shutdownGraceMs ?? 5000); }),
					]);
				} finally { if (timer) clearTimeout(timer); }
			})();
		},
	};
}
