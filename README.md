# pi-rex-panes

A self-contained Pi package that adds the `subagent` tool. Run a single agent, parallel tasks, or a chain with isolated child contexts.

## Install

```sh
pi install npm:pi-rex-panes
```

Disable or remove `~/.pi/agent/extensions/subagent/` before loading this package. Both register `subagent` and must never load together.

For a local checkout:

```sh
bun install
pi --no-extensions -e .
```

## Agents

User agents live in `~/.pi/agent/agents/*.md`. Project agents live in `.pi/agents/*.md` and require `agentScope: "project"` or `"both"`; interactive runs ask for confirmation by default.

```md
---
name: scout
description: Find files and entry points
tools: read, bash
model: openai-codex/gpt-6.1-terra:high
---
Inspect the code and report the relevant paths.
```

The body is appended to the child's system prompt. Model settings accept `provider/id:thinking`. The tool accepts `agent` and `task`, `tasks` for parallel work, or `chain` with `{previous}` placeholders. Set `cwd` on the call or each task to choose its working directory.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun pm pack --dry-run
```

## Source

Ported from `agent-config` branch `build/pi-statusline`, commit `b75cd32a1ad417dff34cb0929295b25b636ca5fa`. Its `UPSTREAM` records a copy from pi-coding-agent 1.5.1 `examples/extensions/subagent` on 2026-11-13. The package includes the shared subagent formatter from that branch. See [LICENSE](LICENSE).
