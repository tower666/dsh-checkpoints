/**
 * Browser half of the workspace-checkpoints bundle.
 *
 * One entry in `conversation.chat.turnTail` per completed turn: it reads that
 * turn's durable checkpoint from the Host and opens a revert dialog that lists
 * the files, previews each file's comparison, and applies only the files the
 * user confirms. The dialog then offers to undo the revert it just made.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'checkpoints'

/** The React module table entry, assigned when the loader factory runs. */
let React

/** Document-relative routes; the page may be served below the origin root. */
const ROUTE_TURNS = 'api/checkpoints.turns'
const ROUTE_PLAN = 'api/checkpoints.plan'
const ROUTE_DIFF = 'api/checkpoints.diff'
const ROUTE_RESTORE = 'api/checkpoints.restore'
const ROUTE_UNDO = 'api/checkpoints.undo'

const zh = {
  'meta.title': '工作区检查点',
  'meta.description': '每轮对话开始与结束时把工作区快照保存到独立的影子 git 仓库，并在展示差异预览、经用户确认后把选中的文件（或整轮全部文件）回退到该快照。',
  'card.title': '本轮改动了 {count} 个文件',
  'card.undo': '撤销本轮的改动…',
  'card.toEnd': '回退到本轮…',
  'row.aria': '本轮的工作区检查点',
  'dialog.undoTitle': '撤销第 {turn} 轮的改动',
  'dialog.endTitle': '回退到第 {turn} 轮',
  'dialog.undoSubtitle': '勾选要撤销的文件：勾选的文件回到本轮开始时的内容，未勾选的保持现状。',
  'dialog.endSubtitle': '把工作区变成第 {turn} 轮结束时的样子：保留到这一轮为止的改动，丢弃这一轮之后的所有改动。',
  'dialog.baseline.start': '基准：本轮开始时',
  'dialog.baseline.end': '基准：本轮结束时',
  'dialog.loading': '正在读取检查点…',
  'dialog.unsupported': '不支持回退（{reason}）',
  'dialog.reason.oversized': '文件过大',
  'dialog.reason.binary': '二进制文件',
  'dialog.delete': '将被删除',
  'dialog.none': '没有可恢复的改动。',
  'dialog.viewDiff': '差异预览',
  'dialog.hideDiff': '收起差异',
  'dialog.diffLoading': '正在读取差异…',
  'dialog.diffFailed': '差异读取失败。',
  'dialog.diffBinary': '二进制文件，无法进行文本对照。',
  'dialog.diffTruncated': '差异内容超出预览上限。',
  'dialog.confirm': '撤销 {count} 个文件',
  'dialog.confirmEnd': '回退 {count} 个文件',
  'dialog.cancel': '取消',
  'dialog.applyFailed': '撤销失败：{message}',
  'dialog.done': '已撤销 {restored} 个文件的改动，删除 {deleted} 个文件。',
  'dialog.doneEnd': '已回退到第 {turn} 轮：恢复 {restored} 个文件，删除 {deleted} 个文件。',
  'dialog.doneSkipped': '{count} 个文件被跳过：{paths}',
  'dialog.undo': '撤销本次回退',
  'dialog.undone': '已撤销本次回退。',
  'dialog.undoFailed': '撤销回退失败：{message}',
  'dialog.close': '关闭',
  'dialog.stale': '预览期间以下文件被改动（{paths}），请重新打开预览。',
  'dialog.retry': '重新预览',
  'dialog.selectAll': '全选',
  'dialog.selectNone': '全不选',
}

const en = {
  'meta.title': 'Workspace Checkpoints',
  'meta.description': 'Keeps a durable git-backed snapshot of the workspace at the start and end of every turn, and reverts chosen files (or a whole turn) after a diff preview and an explicit confirmation.',
  'card.title': '{count} files changed in this turn',
  'card.undo': 'Undo this turn’s changes…',
  'card.toEnd': 'Revert to this turn…',
  'row.aria': 'Workspace checkpoint for this turn',
  'dialog.undoTitle': 'Undo turn {turn}’s changes',
  'dialog.endTitle': 'Revert to the end of turn {turn}',
  'dialog.undoSubtitle': 'Choose the files to undo: a chosen file returns to its content at the start of this turn, an unchosen one is left alone.',
  'dialog.endSubtitle': 'Make the workspace look like the end of turn {turn}: keep everything up to here and drop every later change.',
  'dialog.baseline.start': 'Baseline: the start of this turn',
  'dialog.baseline.end': 'Baseline: the end of this turn',
  'dialog.loading': 'Reading the checkpoint…',
  'dialog.unsupported': 'not revertable ({reason})',
  'dialog.reason.oversized': 'too large',
  'dialog.reason.binary': 'binary',
  'dialog.delete': 'will be deleted',
  'dialog.none': 'Nothing can be restored here.',
  'dialog.viewDiff': 'Diff preview',
  'dialog.hideDiff': 'Hide diff',
  'dialog.diffLoading': 'Reading the diff…',
  'dialog.diffFailed': 'The diff could not be read.',
  'dialog.diffBinary': 'Binary file; no text comparison.',
  'dialog.diffTruncated': 'The comparison is longer than the preview limit.',
  'dialog.confirm': 'Undo {count} files',
  'dialog.confirmEnd': 'Revert {count} files',
  'dialog.cancel': 'Cancel',
  'dialog.applyFailed': 'The undo failed: {message}',
  'dialog.done': 'Undid the changes to {restored} files and removed {deleted}.',
  'dialog.doneEnd': 'Reverted to the end of turn {turn}: restored {restored} files and removed {deleted}.',
  'dialog.doneSkipped': '{count} files were skipped: {paths}',
  'dialog.undo': 'Undo this revert',
  'dialog.undone': 'Revert undone.',
  'dialog.undoFailed': 'Undoing the revert failed: {message}',
  'dialog.close': 'Close',
  'dialog.stale': 'Files changed while the preview was open ({paths}). Reopen the preview.',
  'dialog.retry': 'Preview again',
  'dialog.selectAll': 'Select all',
  'dialog.selectNone': 'Select none',
}

/** Layout constants, all of them theme tokens so light and dark both follow the Host. */
const CSS = `
.dsh-ckpt-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-base) 62%,transparent);backdrop-filter:blur(1px)}
.dsh-ckpt-dialog{display:flex;flex-direction:column;width:min(880px,92vw);max-height:82vh;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent);font-size:13px;overflow:hidden}
.dsh-ckpt-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ckpt-headings{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dsh-ckpt-title{margin:0;font-size:15px;font-weight:600}
.dsh-ckpt-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ckpt-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
.dsh-ckpt-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ckpt-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ckpt-baseline{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ckpt-summary{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ckpt-spacer{flex:1}
.dsh-ckpt-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:12px;cursor:pointer;padding:2px 4px}
.dsh-ckpt-body{flex:1;overflow:auto;padding:6px 10px 12px}
.dsh-ckpt-file{border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ckpt-file:last-child{border-bottom:0}
.dsh-ckpt-filerow{display:flex;align-items:center;gap:10px;padding:7px 8px}
.dsh-ckpt-name{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}
.dsh-ckpt-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsh-ckpt-badges{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dsh-ckpt-add{color:var(--dsw-alias-state-success-primary)}
.dsh-ckpt-del{color:var(--dsw-alias-state-error-primary)}
.dsh-ckpt-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-ckpt-diff{margin:0 8px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;max-height:320px;overflow:auto;white-space:pre}
.dsh-ckpt-hint{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 10px}
.dsh-ckpt-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ckpt-error{color:var(--dsw-alias-state-error-primary);font-size:12px;flex:1;min-width:0}
.dsh-ckpt-done{color:var(--dsw-alias-state-success-primary);font-size:12px;flex:1;min-width:0}
.dsh-ckpt-button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer}
.dsh-ckpt-button:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsh-ckpt-button:disabled{opacity:.55;cursor:not-allowed}
.dsh-ckpt-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.dsh-ckpt-row{display:flex;align-items:center;gap:8px;margin:4px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-ckpt-glyph{color:var(--dsw-alias-brand-primary);font-size:13px;line-height:1}
.dsh-ckpt-trigger{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:999px;padding:2px 10px;font-size:11.5px;cursor:pointer}
.dsh-ckpt-trigger:hover{border-color:var(--dsw-alias-border-l2)}
`

/** Inline styles for the always-rendered row, which needs no stylesheet. */
const ROW = { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
const GLYPH = { color: 'var(--dsw-alias-brand-primary)', fontSize: '13px', lineHeight: 1 }
const TRIGGER = {
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: '999px',
  padding: '2px 10px',
  fontSize: '11.5px',
  cursor: 'pointer',
}
/** A failed request that keeps the Host's stable machine code. */
class CheckpointRequestError extends Error {
  /**
   * @param {string} message - the Host's human-readable reason.
   * @param {string | undefined} code - the Host's stable machine code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'CheckpointRequestError'
    this.code = code
  }
}

/** One readable message from a rejected request. */
function messageOf(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** Read one JSON route, turning a non-2xx body into a thrown error. */
async function getJson(url, signal) {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body.ok === false) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  }
  return body
}

/** Post one JSON body, turning a non-2xx body into a thrown error that keeps the code. */
async function postJson(url, payload, signal) {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body.ok === false) {
    throw new CheckpointRequestError(body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code)
  }
  return body
}

/** The colour role of one unified-diff line. */
function lineStyle(line) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
    return { color: 'var(--dsw-alias-label-secondary)' }
  }
  if (line.startsWith('@@')) return { color: 'var(--dsw-alias-brand-primary)' }
  if (line.startsWith('+')) return { color: 'var(--dsw-alias-state-success-primary)' }
  if (line.startsWith('-')) return { color: 'var(--dsw-alias-state-error-primary)' }
  return undefined
}

/**
 * One file's pending comparison.
 * @param props - the read state and the translator.
 * @returns the diff block, or its placeholder.
 */
function DiffBlock({ state, translate }) {
  const h = React.createElement
  if (state === undefined || state.state === 'loading') {
    return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.diffLoading'))
  }
  if (state.state === 'error') return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.diffFailed'))
  const diff = state.diff
  if (diff.kind === 'binary') return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.diffBinary'))
  if (diff.kind === 'unsupported') {
    return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.unsupported', { reason: translate(`dialog.reason.${diff.reason}`) }))
  }
  const lines = String(diff.text ?? '').split('\n')
  return h(
    'div',
    { className: 'dsh-ckpt-diff' },
    lines.map((line, index) => h('div', { key: index, style: lineStyle(line) }, line.length === 0 ? ' ' : line)),
    diff.truncated === true ? h('div', { key: 'truncated', className: 'dsh-ckpt-hint' }, translate('dialog.diffTruncated')) : null,
  )
}

/**
 * The revert dialog: side switch, file list with per-file comparison, confirm.
 * @param props - Session, turn, translator, and the close callback.
 * @returns the modal.
 */
function RevertDialog({ sessionId, turn, side, translate, onClose }) {
  const h = React.createElement
  const [phase, setPhase] = React.useState('loading')
  const [plan, setPlan] = React.useState(null)
  const [selected, setSelected] = React.useState({})
  const [diffs, setDiffs] = React.useState({})
  const [expanded, setExpanded] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [undoState, setUndoState] = React.useState(null)
  const [failure, setFailure] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const closeRef = React.useRef(onClose)
  closeRef.current = onClose

  React.useEffect(() => {
    let live = true
    setPhase('loading')
    setPlan(null)
    setFailure(null)
    setResult(null)
    setUndoState(null)
    setExpanded(null)
    setDiffs({})
    postJson(ROUTE_PLAN, { sessionId, turn, side })
      .then((body) => {
        if (!live) return
        setPlan(body.plan)
        const next = {}
        for (const file of body.plan.files) {
          if (file.action === 'restore' || file.action === 'delete') next[file.path] = true
        }
        setSelected(next)
        setPhase('ready')
      })
      .catch((error) => {
        if (!live) return
        setFailure(messageOf(error))
        setPhase('error')
      })
    return () => {
      live = false
    }
  }, [sessionId, turn, side, attempt])

  const toEnd = side === 'end'
  const title = toEnd ? translate('dialog.endTitle', { turn }) : translate('dialog.undoTitle', { turn })
  const subtitle = toEnd ? translate('dialog.endSubtitle', { turn }) : translate('dialog.undoSubtitle')
  const baseline = toEnd ? translate('dialog.baseline.end') : translate('dialog.baseline.start')

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const files = plan === null ? [] : plan.files
  const revertable = files.filter((file) => file.action === 'restore' || file.action === 'delete')
  const chosen = revertable.filter((file) => selected[file.path] === true)
  const allChosen = revertable.length > 0 && chosen.length === revertable.length

  const toggle = (path) => setSelected((previous) => ({ ...previous, [path]: previous[path] !== true }))
  const chooseAll = (on) => {
    const next = {}
    if (on) for (const file of revertable) next[file.path] = true
    setSelected(next)
  }

  const showDiff = (path) => {
    if (expanded === path) {
      setExpanded(null)
      return
    }
    setExpanded(path)
    if (diffs[path] !== undefined) return
    setDiffs((previous) => ({ ...previous, [path]: { state: 'loading' } }))
    getJson(`${ROUTE_DIFF}?${new URLSearchParams({ planId: plan.planId, path }).toString()}`)
      .then((body) => setDiffs((previous) => ({ ...previous, [path]: { state: 'ready', diff: body.diff } })))
      .catch(() => setDiffs((previous) => ({ ...previous, [path]: { state: 'error' } })))
  }

  const applyRevert = async () => {
    if (plan === null || chosen.length === 0 || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const body = await postJson(ROUTE_RESTORE, { planId: plan.planId })
      setResult(body)
      setPhase('applied')
    } catch (error) {
      setFailure(messageOf(error))
      const code = error instanceof CheckpointRequestError ? error.code : undefined
      if (code === 'checkpoints/stale' || code === 'checkpoints/plan-consumed' || code === 'checkpoints/plan-expired') {
        setPhase('error')
      }
    } finally {
      setBusy(false)
    }
  }

  const undoRevert = async () => {
    if (result === null || result.undo === undefined || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await postJson(ROUTE_UNDO, { undoId: result.undo.id })
      setUndoState('undone')
    } catch (error) {
      setFailure(translate('dialog.undoFailed', { message: messageOf(error) }))
    } finally {
      setBusy(false)
    }
  }

  const body = (() => {
    if (phase === 'loading') return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.loading'))
    if (phase === 'error' || plan === null) {
      return h(
        'div',
        { className: 'dsh-ckpt-hint' },
        h('div', null, failure === null ? translate('dialog.diffFailed') : failure),
        h(
          'button',
          { type: 'button', className: 'dsh-ckpt-button', style: { marginTop: '8px' }, onClick: () => setAttempt((n) => n + 1) },
          translate('dialog.retry'),
        ),
      )
    }
    if (revertable.length === 0 && phase !== 'applied') {
      return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.none'))
    }
    return files.map((file) =>
      h(
        'div',
        { key: file.path, className: 'dsh-ckpt-file' },
        h(
          'div',
          { className: 'dsh-ckpt-filerow' },
          h(
            'label',
            { className: 'dsh-ckpt-name' },
            h('input', {
              type: 'checkbox',
              checked: selected[file.path] === true,
              disabled: file.action === 'unsupported' || phase === 'applied',
              onChange: () => toggle(file.path),
            }),
            h('code', { className: 'dsh-ckpt-path' }, file.path),
          ),
          h(
            'span',
            { className: 'dsh-ckpt-badges' },
            file.action === 'unsupported'
              ? h('span', { className: 'dsh-ckpt-warn' }, translate('dialog.unsupported', { reason: translate(`dialog.reason.${file.reason}`) }))
              : null,
            file.action === 'delete' ? h('span', { className: 'dsh-ckpt-warn' }, translate('dialog.delete')) : null,
            typeof file.added === 'number' && file.added > 0 ? h('span', { className: 'dsh-ckpt-add' }, `+${file.added}`) : null,
            typeof file.deleted === 'number' && file.deleted > 0 ? h('span', { className: 'dsh-ckpt-del' }, `−${file.deleted}`) : null,
            file.action === 'unsupported'
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'dsh-ckpt-link', onClick: () => showDiff(file.path) },
                  translate(expanded === file.path ? 'dialog.hideDiff' : 'dialog.viewDiff'),
                ),
          ),
        ),
        expanded === file.path ? h(DiffBlock, { state: diffs[file.path], translate }) : null,
      ),
    )
  })()

  const footer = (() => {
    if (phase === 'applied' && result !== null) {
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsh-ckpt-done' },
          undoState === 'undone'
            ? translate('dialog.undone')
            : toEnd
              ? translate('dialog.doneEnd', { turn, restored: result.restored, deleted: result.deleted })
              : translate('dialog.done', { restored: result.restored, deleted: result.deleted }),
          result.skipped !== undefined && result.skipped.length > 0
            ? h('div', null, translate('dialog.doneSkipped', { count: result.skipped.length, paths: result.skipped.join(', ') }))
            : null,
        ),
        result.undo === undefined
          ? null
          : h(
              'button',
              { type: 'button', className: 'dsh-ckpt-button', disabled: busy || undoState === 'undone', onClick: undoRevert },
              translate('dialog.undo'),
            ),
        h('button', { type: 'button', className: 'dsh-ckpt-button', onClick: () => closeRef.current(true) }, translate('dialog.close')),
      )
    }
    return h(
      React.Fragment,
      null,
      failure !== null && phase === 'ready' ? h('div', { className: 'dsh-ckpt-error' }, translate('dialog.applyFailed', { message: failure })) : h('div', { className: 'dsh-ckpt-spacer' }),
      h('button', { type: 'button', className: 'dsh-ckpt-button', disabled: busy, onClick: () => closeRef.current(false) }, translate('dialog.cancel')),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-ckpt-button dsh-ckpt-primary',
          disabled: busy || chosen.length === 0 || phase !== 'ready',
          onClick: applyRevert,
        },
        toEnd ? translate('dialog.confirmEnd', { count: chosen.length }) : translate('dialog.confirm', { count: chosen.length }),
      ),
    )
  })()

  return h(
    'div',
    {
      className: 'dsh-ckpt-overlay',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) closeRef.current(false)
      },
    },
    h(
      'div',
      { className: 'dsh-ckpt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('style', null, CSS),
      h(
        'div',
        { className: 'dsh-ckpt-head' },
        h(
          'div',
          { className: 'dsh-ckpt-headings' },
          h('h2', { className: 'dsh-ckpt-title' }, title),
          h('p', { className: 'dsh-ckpt-sub' }, subtitle),
        ),
        h('button', { type: 'button', className: 'dsh-ckpt-close', 'aria-label': translate('dialog.close'), onClick: () => closeRef.current(false) }, '✕'),
      ),
      h(
        'div',
        { className: 'dsh-ckpt-controls' },
        h(
          'span',
          { className: 'dsh-ckpt-baseline' },
          baseline,
        ),
        plan === null
          ? null
          : h(
              'span',
              { className: 'dsh-ckpt-summary' },
              `${plan.totals.files} files · +${plan.files.reduce((sum, file) => sum + (typeof file.added === 'number' ? file.added : 0), 0)} −${plan.files.reduce((sum, file) => sum + (typeof file.deleted === 'number' ? file.deleted : 0), 0)}`,
            ),
        h('span', { className: 'dsh-ckpt-spacer' }),
        revertable.length === 0
          ? null
          : h(
              'button',
              { type: 'button', className: 'dsh-ckpt-link', disabled: phase === 'applied', onClick: () => chooseAll(!allChosen) },
              translate(allChosen ? 'dialog.selectNone' : 'dialog.selectAll'),
            ),
      ),
      h('div', { className: 'dsh-ckpt-body' }, body),
      h('div', { className: 'dsh-ckpt-foot' }, footer),
    ),
  )
}

/** Milliseconds one Session's turn list stays readable without a new request. */
const TURNS_TTL_MS = 5_000

/** Session → the shared read of its recorded turns. */
const turnsReads = new Map()

/**
 * Read one Session's recorded turns, so every card of a conversation shares a
 * single request instead of one per turn.
 * @param {string} sessionId - the conversation.
 * @param {boolean} force - ignore a cached answer.
 * @returns {Promise<Array<any>>} the recorded turns.
 */
function readTurns(sessionId, force) {
  const existing = turnsReads.get(sessionId)
  if (existing !== undefined && force !== true && Date.now() - existing.at < TURNS_TTL_MS) return existing.promise
  /** @type {{ at: number, promise: Promise<Array<any>> }} */
  const entry = {
    at: Date.now(),
    promise: getJson(`${ROUTE_TURNS}?${new URLSearchParams({ sessionId }).toString()}`).then(
      (body) => (Array.isArray(body.turns) ? body.turns : []),
      (error) => {
        turnsReads.delete(sessionId)
        throw error
      },
    ),
  }
  turnsReads.set(sessionId, entry)
  return entry.promise
}

/** Forget one Session's cached list; a revert changed the workspace it describes. */
function forgetTurns(sessionId) {
  turnsReads.delete(sessionId)
}

/**
 * The turn-tail card that opens the dialog.
 * @param props - the turn, the Session, and the host translator.
 * @returns the card, or null when this turn has no checkpoint.
 */
function Card(props) {
  const h = React.createElement
  const { turn, sessionId, t } = props
  const turnNumber = turn !== null && typeof turn === 'object' && typeof turn.turn === 'number' ? turn.turn : undefined
  const translate = React.useCallback(
    (key, vars) => {
      if (typeof t !== 'function') return key
      try {
        return t(key, vars)
      } catch {
        return key
      }
    },
    [t],
  )
  const [entry, setEntry] = React.useState(null)
  const [latestTurn, setLatestTurn] = React.useState(undefined)
  const [dialogSide, setDialogSide] = React.useState(null)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    if (typeof sessionId !== 'string' || turnNumber === undefined) return undefined
    let live = true
    readTurns(sessionId, tick > 0)
      .then((turns) => {
        if (!live) return
        const found = turns.find((item) => item.turn === turnNumber)
        setEntry(found === undefined ? null : found)
        setLatestTurn(turns.length > 0 ? turns[turns.length - 1].turn : undefined)
      })
      .catch(() => {
        if (live) setEntry(null)
      })
    return () => {
      live = false
    }
  }, [sessionId, turnNumber, tick])

  if (entry === null) return null
  // The newest turn can only be undone (nothing follows it); every earlier turn
  // is a point to go back to, which keeps it and drops what came after.
  const isLatest = latestTurn === undefined || turnNumber === undefined || turnNumber >= latestTurn
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'dsh-ckpt-row', style: ROW, 'aria-label': translate('row.aria') },
      h('span', { style: GLYPH, 'aria-hidden': 'true' }, '⟲'),
      h('span', null, translate('card.title', { count: entry.total })),
      isLatest
        ? h('button', { type: 'button', style: TRIGGER, onClick: () => setDialogSide('start') }, translate('card.undo'))
        : h('button', { type: 'button', style: TRIGGER, onClick: () => setDialogSide('end') }, translate('card.toEnd')),
    ),
    dialogSide === null
      ? null
      : h(RevertDialog, {
          sessionId,
          turn: turnNumber,
          side: dialogSide,
          translate,
          onClose: (changed) => {
            setDialogSide(null)
            if (changed === true) setTick((value) => value + 1)
          },
        }),
  )
}

/** The page's client module table, typed only as far as this module uses it. */
const loader = /** @type {{ __ModuleLoader__: { load: (entry: { id: string, factory: (require: (name: string) => any) => unknown }) => void } }} */ (/** @type {unknown} */ (window))

loader.__ModuleLoader__.load({
  id: 'dsh-checkpoints',
  factory(require) {
    React = require('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'checkpoints: dictionaries')
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'dsh-checkpoints',
              order: 30,
              locale: NS,
            },
            Card,
          ),
        )
      },
    }
  },
})
