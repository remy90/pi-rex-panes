import type { PaneOptions, RexClient } from "./client.ts";

export function createPlacement(rex: RexClient, parent: string) {
	let panes: string[] = [];
	let pending = Promise.resolve();
	return {
		forget(id: string) { panes = panes.filter((pane) => pane !== id); },
		open(options: Omit<PaneOptions, "anchor" | "direction" | "ratio">, signal?: AbortSignal): Promise<string> {
			const opened = pending.then(async () => {
				signal?.throwIfAborted();
				if (panes.length) {
					const live = await rex.listPaneIds();
					panes = panes.filter((id) => live.has(id));
				}
				signal?.throwIfAborted();
				const latest = panes.at(-1);
				const id = await rex.openPane({
					...options, anchor: latest ?? parent,
					direction: latest ? "below" : "right", ratio: latest ? 50 : 40,
				});
				panes.push(id);
				return id;
			});
			pending = opened.then(() => {}, () => {});
			return opened;
		},
	};
}

export type Placement = ReturnType<typeof createPlacement>;
