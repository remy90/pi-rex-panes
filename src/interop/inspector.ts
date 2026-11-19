import { withinGrace } from "../grace.ts";
import { createRexClient, runCommand, type RexClient, type Runner } from "../rex/client.ts";
import { findRex } from "../rex/lookup.ts";
import { createPlacement, type Placement } from "../rex/placement.ts";
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
	pi.on("session_start", (_event, ctx) => {
		registration?.dispose();
		registration = undefined;
		if (pi.getFlag(REPORT_FLAG)) return;
		const request: InspectorRegistrationRequest = { version: 1, plugin: inspector.plugin };
		pi.events.emit(INSPECTOR_REGISTER_EVENT, request);
		if (request.result?.ok) registration = request.result.registration;
		else if (request.result && !logged) {
			const message = `pi-rex-panes inspector registration failed: ${request.result.error.message}`;
			if (deps.log) {
				deps.log(message);
				logged = true;
			} else if (ctx.hasUI) {
				ctx.ui.notify(message, "warning");
				logged = true;
			}
		}
	});
	let closing: Promise<void> | undefined;
	return {
		registered: () => registration !== undefined,
		available: (env = process.env) => registration !== undefined && inspector.available(env),
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

interface PaneEntry {
	id: string;
	rex: RexClient;
	placement: Placement;
}

export function createInspector(deps: InspectorDeps = {}) {
	const lookup = deps.lookup ?? findRex;
	const runner = deps.runner ?? runCommand;
	const panes = new Map<string, PaneEntry>();
	const opening = new Map<string, Promise<InspectorResult>>();
	const shutdownSignal = new AbortController();
	const key = (ctx: InspectorContext) => JSON.stringify([ctx.target.runId, ctx.target.index ?? null]);
	let connection: Omit<PaneEntry, "id"> | undefined;
	const connect = (ctx: InspectorContext) => {
		if (connection) return connection;
		const binary = lookup(ctx.env);
		if (!binary || !ctx.env.REX_SESSION || !ctx.env.REX_BLOCK) throw new Error("Rex inspector is unavailable");
		const rex = createRexClient(binary, ctx.env.REX_SESSION, runner);
		return connection = {
			rex, placement: createPlacement(rex, ctx.env.REX_BLOCK),
		};
	};
	const forget = (target: string, pane: PaneEntry) => {
		pane.placement.forget(pane.id);
		panes.delete(target);
	};
	const closeEntry = async (target: string): Promise<InspectorResult> => {
		const pane = panes.get(target);
		if (!pane) return result("Rex inspector is closed.");
		const { id, rex } = pane;
		try {
			const closed = await rex.closePane(id);
			if (closed.code !== 0 && (await rex.listPaneIds()).has(id)) {
				return result(closed.stderr || `Could not close Rex inspector ${id}.`, true);
			}
			forget(target, pane);
			return result(`Closed Rex inspector ${id}. The run continues.`);
		} catch (error) { return result(String(error), true); }
	};
	const reusablePane = async (target: string): Promise<{ pane?: PaneEntry; error?: InspectorResult }> => {
		const pane = panes.get(target);
		if (!pane) return {};
		if (!(await pane.rex.listPaneIds()).has(pane.id)) {
			forget(target, pane);
			return {};
		}
		const state = await pane.rex.paneProcess(pane.id).catch(() => "unknown");
		if (state !== "exited") return { pane };
		const closed = await closeEntry(target);
		return closed.isError ? { error: closed } : {};
	};
	const available = (env = process.env) => Boolean(env.REX_SESSION && env.REX_BLOCK && lookup(env));
	const plugin: InspectorPlugin = {
		name: "rex-panes",
		available: (ctx) => available(ctx.env),
		owns: (ctx) => panes.has(key(ctx)),
		async open(ctx, launch, params) {
			const existing = opening.get(key(ctx));
			if (existing) return existing;
			const operation = (async () => {
				try {
					shutdownSignal.signal.throwIfAborted();
					const reusable = await reusablePane(key(ctx));
					if (reusable.error) return reusable.error;
					const { rex, placement } = reusable.pane ?? connect(ctx);
					const id = reusable.pane?.id ?? await placement.open({
						label: `pi-inspector-${ctx.target.runId}`, cwd: ctx.target.status.cwd ?? ctx.cwd,
						argv: [launch.executable, ...launch.argv],
					}, ctx.signal ? AbortSignal.any([ctx.signal, shutdownSignal.signal]) : shutdownSignal.signal);
					panes.set(key(ctx), { id, rex, placement });
					if (params.focus) {
						try {
							await rex.focusPane(id);
						} catch { /* The inspector remains open when focus fails. */ }
					}
					return result(`Opened Rex inspector ${id}.`);
				} catch (error) { return result(String(error), true); }
			})();
			opening.set(key(ctx), operation);
			try { return await operation; } finally { opening.delete(key(ctx)); }
		},
		async status(ctx) {
			const pane = panes.get(key(ctx));
			if (!pane) return result("Rex inspector is closed.");
			try {
				if ((await pane.rex.listPaneIds()).has(pane.id)) return result(`Rex inspector ${pane.id} is open.`);
				forget(key(ctx), pane);
				return result("Rex inspector is closed.");
			} catch (error) { return result(String(error), true); }
		},
		close: (ctx) => closeEntry(key(ctx)),
	};
	let stopping: Promise<void> | undefined;
	return {
		plugin,
		available,
		shutdown() {
			if (stopping) return stopping;
			shutdownSignal.abort();
			const cleanup = async () => {
				await Promise.allSettled([...opening.values()]);
				await Promise.allSettled([...panes].map(async ([target, pane]) => {
					const closed = await pane.rex.closePane(pane.id);
					if (closed.code !== 0) throw new Error(closed.stderr || `Could not close Rex inspector ${pane.id}`);
					forget(target, pane);
				}));
			};
			return stopping = withinGrace(cleanup(), deps.shutdownGraceMs);
		},
	};
}
