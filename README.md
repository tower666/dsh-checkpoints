# dsh-checkpoints

Persistent, per-turn workspace checkpoints with a previewed, approved, and
undoable revert — the "Cursor checkpoints" behaviour for the DeepSeek Harness
Web UI.

The shipped `@deepseek-ai/dsh-workspace-changes` plugin records what a turn
changed and shows its diff, but its snapshots live in the Session's temporary
directory and disappear when the Session or the Host ends, and it offers no
revert. This bundle adds both: a **shadow git repository** that survives
restarts, and a **revert** that can be applied to one file or to a whole turn.

## Install

The package is a **bundle**: installing it also selects it in the profile, and
a running Host loads it after one restart.

### From npm (recommended)

```
dsh plugin --profile web add dsh-checkpoints
```

Or install `dsh-checkpoints` by name: ask the agent — the Creator preset's
`plugin_manager` tool takes the package name as `install_bundle`'s `target` —
or paste the name into **Plugins → Add**. The package page is
<https://www.npmjs.com/package/dsh-checkpoints>.

### From git

```
git+https://github.com/tower666/dsh-checkpoints.git#v1.1.0
```

Same entry points as above, with that spec as the target. Use it when you want
an exact source tree without the registry: a tag keeps the instruction
readable, and a commit (`#<40-hex sha>`) makes the target immutable.

### From a local checkout

Point `install_bundle` at this directory's absolute path.

### Upgrading

There is no upgrade path yet: remove the bundle, then install the newer version,
tag, or commit. Checkpoints under `$DSH_HOME/workspace-checkpoints` survive
both, so the conversation history keeps working.

## What it does

- **Records** a snapshot of the workspace at `turn/start` and again at
  `turn/end` into a shadow repository under the Harness home, and persists the
  turn's changed-file list in a small catalog next to it.
- **Serves** that history to the Web page: one row under each completed turn,
  plus the `/api/checkpoints.*` routes.
- **Offers two actions per turn**, both behind one dialog that lists the files,
  previews each one's unified diff, and writes only the files you tick — all of
  them or just one:
  - **Undo this turn's changes** — puts back the files *this turn* changed, at
    their content from the start of the turn; files the turn did not touch are
    left alone.
  - **Revert to this turn** — makes the workspace look like the *end* of that
    turn: everything up to it is kept, every change any later turn made is
    dropped. Hidden on the newest turn, where nothing follows it yet.

  The overwritten state is snapshotted first, so either action can itself be
  undone.
- **Exposes** the same operation to the model as the `workspace_checkpoint`
  tool, which asks the DSH approval answerers before it writes anything.

## Mount

```yaml
- name: 'dsh-checkpoints'
  config:
    maxFileBytes: 2097152
```

| Field | Default | Meaning |
|---|---|---|
| `storeDir` | `$DSH_HOME/workspace-checkpoints` | Where the shadow repositories and the catalog live. |
| `timeoutMs` | `30000` | Milliseconds one git command may run. |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command. |
| `maxFileBytes` | `2097152` | Largest snapshot blob the revert will write or diff; a bigger one is reported as `unsupported: oversized`. |
| `maxDiffBytes` | `524288` | Bytes of unified-diff text one preview may carry. |
| `maxTurnsPerSession` | `300` | Turns the catalog keeps per Session before the oldest are forgotten. |
| `planTtlMs` | `600000` | How long an unapplied preview stays valid. |

The bundle deliberately declares **no `Config` schema**: a bundle installed from
a workspace directory resolves its imports from that directory, so it cannot
depend on the schema library the Host ships. Invalid values fall back to these
defaults instead of failing activation.

## Safety model

- The user's repository is never written. Every snapshot command runs with
  `GIT_DIR` at the shadow repository and its own persistent index, and the
  user's object store is attached only as a read-only
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` entry. No ref, index entry, object, or
  commit is created there; `test/integration-git.mjs` hashes the whole `.git`
  tree before and after to prove it.
- `core.autocrlf=false` and `core.safecrlf=false` with an empty
  `GIT_CONFIG_GLOBAL` keep stored and restored bytes exact, whatever the user's
  global git configuration says.
- A working directory outside any repository still gets checkpoints: the shadow
  repository is self-contained and needs no user repository at all.
- A revert is two-phase. `/api/checkpoints.plan` reads only; the returned
  `planId` is single-use, expires after `planTtlMs`, and `/api/checkpoints.restore`
  refuses it when any planned file changed while the preview was open.
  Every path is resolved against the recorded workspace root and rejected when it
  is absolute or escapes it.
- The state a revert overwrites is snapshotted first, and `/api/checkpoints.undo`
  restores it.
- The agent tool routes the same write through `ctx.approval.request()`, so the
  session's approval policy decides it and `'unavailable'` fails closed. The
  approval service requires an open turn; the Web route is therefore gated by its
  own explicit preview-and-confirm handshake instead, which the user performs in
  the dialog.
- Snapshot blobs larger than `maxFileBytes` are listed but never written; the
  dialog marks them "not revertable".

## Routes

All are exact routes on `ctx.connection.fetch`, below `/api`, so they sit inside
Connection's authentication fence and answer no-cache JSON.

| Route | Method | Purpose |
|---|---|---|
| `/api/checkpoints.turns?sessionId=` | GET | Every recorded turn of one Session. |
| `/api/checkpoints.plan` | POST | Prepare a revert preview (`{sessionId, turn, side?, paths?}`): `side: 'start'` (default) undoes that turn's own files, `side: 'end'` restores the workspace to the end of that turn. |
| `/api/checkpoints.diff?planId=&path=` | GET | One file's unified diff for that preview. |
| `/api/checkpoints.restore` | POST | Apply a preview (`{planId}`). |
| `/api/checkpoints.undo` | POST | Undo an applied revert (`{undoId}`). |

## The turn row

Each completed turn of the conversation carries one row with one action, chosen
by the turn's position:

```
newest turn    ⟲ 3 files changed in this turn   [Undo this turn’s changes…]
earlier turns  ⟲ 3 files changed in this turn   [Revert to this turn…]
```

| Turn | Action | Baseline | File list |
|---|---|---|---|
| newest | Undo this turn's changes | the start of this turn | the files *this turn* changed |
| earlier | Revert to this turn | the end of this turn | every path that differs between the end of this turn and now |

The newest turn has nothing after it, so "go back to here" would be a no-op; it
offers the undo instead. Every earlier turn is a point to return to: reverting
to it keeps that turn's own work and removes the later turns' additions and
edits.

One consequence worth knowing: undoing a *single historical* turn while keeping
the later ones is not offered by the row. The row answers "what do I do at this
position", and at a historical position the useful answer is "return here".

Either dialog lists the files with their line counts, previews each file's
unified diff on demand, offers select-all/select-none, and writes only the
ticked files. A file the baseline does not hold is marked "will be deleted",
an oversized snapshot blob "not revertable". After applying, the dialog offers
to undo the action itself.

## Store layout

```
$DSH_HOME/workspace-checkpoints/
  catalog.json                 # session → turn → {beforeTree, afterTree, files}
  empty-gitconfig              # the empty global config every git call uses
  repos/<sha1(workspace)>/     # one shadow repository per workspace
    .git/                      # its own objects, index untouched by the user
    index                      # the persistent shadow index
    tmp/                       # scratch indexes for restores and previews
```

Tree objects are content addressed, so unchanged content costs nothing after the
first snapshot, and committed blobs are read from the user's repository through
the alternate instead of being copied.

## Develop

```
node test/smoke.mjs            # recorder + service: preview, restore, undo, persistence
node test/integration-git.mjs  # a real repository stays byte-identical
node test/routes.mjs           # the five /api route handlers
node test/client.mjs           # the browser half's registration and render tree
```

`test/live-check.mjs <sessionId> <storeDir> <workspace> <file>` replays the
service from a fresh process against a store the running Host wrote.

Each suite builds its fixtures under `.scratch/` in the directory it is run
from, so delete that directory afterwards; nothing else outside `test/` is
written.

## Verification

Every suite replaces the Host `subprocess` capability with a child-process
adapter and file-backed stdio, so the suites also run inside the DSH file
sandbox, where piped child stdio is refused.

`tsc --checkJs` over the package is clean:

```
node <dsh-install>/node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs \
  --noImplicitAny false --target es2022 --module nodenext --moduleResolution nodenext \
  --skipLibCheck --lib es2022,dom \
  --typeRoots <dsh-install>/node_modules/@deepseek-ai/dsh/node_modules/@types --types node \
  index.js client.js lib/*.js
```
