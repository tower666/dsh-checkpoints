# dsh-checkpoints

Per-turn git checkpoints for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a durable snapshot of the workspace at the start and the end of every turn, with
a previewed, undoable revert — like Cursor's checkpoints.

The bundle lives in [`bundle/`](bundle/README.md). This repository root only
holds the package and its tests.

## What you get

Under every completed turn of a conversation, one action:

- **Undo this turn's changes** (newest turn) — puts back the files that turn
  changed, at their content from the start of the turn.
- **Revert to this turn** (earlier turns) — makes the workspace look like the end
  of that turn: everything up to it is kept, every later change is dropped.

Each action opens a dialog listing the files and previewing their unified diffs;
it writes only the files you tick, and the state it overwrites is snapshotted
first, so the action can be undone too.

The snapshots live in a **shadow git repository** under the Harness home, so they
survive restarts and never touch your repository's index, objects, refs, or
history. No commit is created anywhere.

## Install

```
dsh plugin add dsh-checkpoints
```

or, from the Web UI, **Plugins → Add**, or the Creator preset's
`plugin_manager` tool with this package name.

For a checkout, point `install_bundle` at the absolute `bundle/` directory.

## Develop

```
node test/smoke.mjs            # recorder + service: preview, restore, undo, persistence
node test/integration-git.mjs  # a real repository stays byte-identical
node test/routes.mjs           # the five /api route handlers
node test/client.mjs           # the browser half's registration and render tree
```

Each suite creates its fixtures under `.scratch/` in the directory it runs from.

## License

MIT
