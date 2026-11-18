# Changelog

## [0.1.0]

### Added

- Port the subagent extension and its shared formatter as a self-contained Pi package.
- Run interactive Pi children in Rex splits with serialized placement and focus preserved on the parent.
- Tail private child reports into the existing tool results and usage display.
- Keep failures visible and close successful panes, with `PI_REX_PANES_KEEP=1` to retain them.
- Close panes on abort and clean up active pane tasks when the parent session shuts down.
- Preserve headless execution outside Rex and support `PI_REX_PANES=0`.
