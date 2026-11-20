# Changelog

## [0.2.0]

### Added

- Stand down when another extension owns `subagent`, with one notice per session naming its path.
- Open pi-subagents' inspector dashboard in Rex splits from Fleet. Close inspector panes when the parent session shuts down.
- Configure successful pane linger through `PI_REX_PANES_LINGER_SECONDS` or `rexPanes.lingerSeconds` in Pi settings.

### Changed

- Start pane children with `PI_PROGRAM_STATUS=0` so Rex does not notify when a child finishes.
- Forward the parent's non-empty `PI_CODING_AGENT_DIR` to pane children so they load the same Pi configuration.
- Return tool results as soon as the child settles. Successful panes linger for 180 seconds by default, with focus extending the delay until 30 seconds after focus leaves. The parent checks focus every 5 seconds.
- Let the parent close successful children and clean up lingering panes during session shutdown. A child checks for parent exit every 2 seconds and shuts down if the parent dies. `PI_REX_PANES_KEEP=1` retains finished panes indefinitely, including after parent exit.
- Limit close-failure warnings in tool results to task aborts. Background linger cleanup failures produce no warning.

## [0.1.0]

### Added

- Port the subagent extension and its shared formatter as a self-contained Pi package.
- Run interactive Pi children in Rex splits with serialized placement and focus preserved on the parent.
- Tail private child reports into the existing tool results and usage display.
- Keep failures visible and close successful panes, with `PI_REX_PANES_KEEP=1` to retain them.
- Close panes on abort and clean up active pane tasks when the parent session shuts down.
- Preserve headless execution outside Rex and support `PI_REX_PANES=0`.
- Fail pane runs that report no `agent_start` within 60 seconds, with `PI_REX_PANES_START_TIMEOUT_MS` to adjust the wait.
- Retry failed pane closes once and retain open panes as placement anchors. Include the block ID in a warning when closure remains unconfirmed.
- Recover from Rex wait failures with bounded retries and process-state checks while child reports continue.
