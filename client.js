/**
 * Browser half of the workspace-checkpoints bundle.
 *
 * One entry in `conversation.chat.turnTail` per completed turn: it reads that
 * turn's durable checkpoint from the Host and opens a revert dialog that lists
 * the changed files, previews each file's comparison, and reverts all of them.
 * The same action also forgets the turn's conversation for the model.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'checkpoints'

/** The React module table entry, assigned when the loader factory runs. */
let React

/** Document-relative routes; the page may be served below the origin root. */
const ROUTE_TURNS = 'api/checkpoints.turns'
const ROUTE_PLAN = 'api/checkpoints.plan'
const ROUTE_RESTORE = 'api/checkpoints.restore'

const zh = {
  'meta.title': '工作区检查点',
  'meta.description': '每轮对话开始与结束时把工作区快照保存到独立的影子 git 仓库，并在展示差异预览、经用户确认后把选中的文件（或整轮全部文件）回退到该快照。',
  'card.title': '本轮改动了 {count} 个文件',
  'card.undo': '回退并遗忘',
  'card.toEnd': '回退到此处并遗忘之后对话',
  'card.forgotten': '本轮对话已被遗忘，不进入上下文',
  'card.forgottenAria': '本轮对话已被遗忘，不进入模型上下文',
  'row.aria': '本轮的工作区检查点',
  'dialog.undoTitle': '回退并遗忘第 {turn} 轮',
  'dialog.endTitle': '回退到第 {turn} 轮并遗忘之后对话',
  'dialog.undoSubtitle': '撤销本轮改动，并遗忘本轮对话。',
  'dialog.endSubtitle': '把工作区变成第 {turn} 轮结束时的样子，并遗忘第 {from}–{to} 轮的对话。',
  'dialog.loading': '正在读取检查点…',
  'dialog.loadFailed': '读取检查点失败。',
  'dialog.unsupported': '不支持回退（{reason}）',
  'dialog.reason.oversized': '文件过大',
  'dialog.reason.binary': '二进制文件',
  'dialog.delete': '将被删除',
  'dialog.none': '没有需要回退的文件。',
  'dialog.confirm': '回退 {count} 个文件并遗忘本轮',
  'dialog.confirmEnd': '回退 {count} 个文件并遗忘后续对话',
  'dialog.cancel': '取消',
  'dialog.applyFailed': '回退失败：{message}',
  'dialog.close': '关闭',
  'dialog.retry': '重新预览',
}

const en = {
  'meta.title': 'Workspace Checkpoints',
  'meta.description': 'Keeps a durable git-backed snapshot of the workspace at the start and end of every turn, and reverts chosen files (or a whole turn) after a diff preview and an explicit confirmation.',
  'card.title': '{count} files changed in this turn',
  'card.undo': 'Revert and forget',
  'card.toEnd': 'Revert here and forget later turns',
  'card.forgotten': 'This turn’s conversation was forgotten; not in context',
  'card.forgottenAria': 'This turn’s conversation was forgotten and no longer enters the model context',
  'row.aria': 'Workspace checkpoint for this turn',
  'dialog.undoTitle': 'Revert and forget turn {turn}',
  'dialog.endTitle': 'Revert to turn {turn} and forget later turns',
  'dialog.undoSubtitle': 'Undo this turn’s changes and forget this turn’s conversation.',
  'dialog.endSubtitle': 'Make the workspace look like the end of turn {turn}, and forget the conversation of turns {from}–{to}.',
  'dialog.loading': 'Reading the checkpoint…',
  'dialog.loadFailed': 'Could not read the checkpoint.',
  'dialog.unsupported': 'not revertable ({reason})',
  'dialog.reason.oversized': 'too large',
  'dialog.reason.binary': 'binary',
  'dialog.delete': 'will be deleted',
  'dialog.none': 'No files need to be reverted.',
  'dialog.confirm': 'Revert {count} files and forget this turn',
  'dialog.confirmEnd': 'Revert {count} files and forget later turns',
  'dialog.cancel': 'Cancel',
  'dialog.applyFailed': 'The revert failed: {message}',
  'dialog.close': 'Close',
  'dialog.retry': 'Preview again',
}

/** Layout constants, all of them theme tokens so light and dark both follow the Host. */
const CSS = `
@keyframes dsh-ckpt-fade{from{opacity:0}to{opacity:1}}
@keyframes dsh-ckpt-pop{from{opacity:0;transform:translateY(5px) scale(.99)}to{opacity:1;transform:none}}
.dsh-ckpt-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 56%,transparent);backdrop-filter:blur(3px);animation:dsh-ckpt-fade .14s ease}
.dsh-ckpt-dialog{display:flex;flex-direction:column;width:min(460px,100%);max-height:min(560px,86vh);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 44px -16px color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent),0 2px 8px color-mix(in srgb,var(--dsw-alias-bg-base) 26%,transparent);font-size:13px;overflow:hidden;animation:dsh-ckpt-pop .16s ease}
.dsh-ckpt-head{display:flex;align-items:flex-start;gap:10px;padding:14px 18px 0}
.dsh-ckpt-icon{display:flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:14px;line-height:1}
.dsh-ckpt-headings{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.dsh-ckpt-title{margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em;line-height:1.35}
.dsh-ckpt-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.dsh-ckpt-close{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;border-radius:6px;transition:background .12s ease,color .12s ease}
.dsh-ckpt-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ckpt-body{flex:1;overflow:auto;padding:12px 18px 14px}
.dsh-ckpt-list{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dsh-ckpt-file{border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ckpt-file:last-child{border-bottom:0}
.dsh-ckpt-filerow{display:flex;align-items:center;gap:10px;padding:7px 11px}
.dsh-ckpt-name{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.dsh-ckpt-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsh-ckpt-badges{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dsh-ckpt-add{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.dsh-ckpt-del{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums}
.dsh-ckpt-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-ckpt-hint{color:var(--dsw-alias-label-secondary);font-size:12px;padding:8px 10px}
.dsh-ckpt-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ckpt-spacer{flex:1}
.dsh-ckpt-error{color:var(--dsw-alias-state-error-primary);font-size:12px;flex:1;min-width:0}
.dsh-ckpt-button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font-size:12.5px;font-weight:500;cursor:pointer;transition:border-color .12s ease,background .12s ease,opacity .12s ease}
.dsh-ckpt-button:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsh-ckpt-button:disabled{opacity:.5;cursor:not-allowed}
.dsh-ckpt-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.dsh-ckpt-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}
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
/** The badge a forgotten turn carries: it no longer enters the model context. */
const FORGOTTEN = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 9px',
  borderRadius: '999px',
  fontSize: '11px',
  color: 'var(--dsw-alias-state-warn-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
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

/**
 * The revert dialog: the changed files and a confirm action.
 * @param props - Session, turn, translator, and the close callback.
 * @returns the modal.
 */
function RevertDialog({ sessionId, turn, side, latestTurn, translate, onClose }) {
  const h = React.createElement
  const [phase, setPhase] = React.useState('loading')
  const [plan, setPlan] = React.useState(null)
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
    postJson(ROUTE_PLAN, { sessionId, turn, side, forget: true })
      .then((body) => {
        if (!live) return
        setPlan(body.plan)
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
  // The turn range the model stops seeing: this turn for the newest action or
  // every later turn for a historical one.
  const forgetFrom = toEnd ? turn + 1 : turn
  const forgetTo = toEnd && typeof latestTurn === 'number' ? latestTurn : turn
  const title = toEnd ? translate('dialog.endTitle', { turn }) : translate('dialog.undoTitle', { turn })
  const subtitle = toEnd
    ? translate('dialog.endSubtitle', { turn, from: forgetFrom, to: forgetTo })
    : translate('dialog.undoSubtitle')

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const files = plan === null ? [] : plan.files
  // The action always reverts every changed file; the list is a preview only.
  const revertable = files.filter((file) => file.action === 'restore' || file.action === 'delete')

  const applyRevert = async () => {
    if (plan === null || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await postJson(ROUTE_RESTORE, { planId: plan.planId })
      // The revert is final; close at once so the user does not dismiss a
      // second dialog just to see the result.
      bumpTurns(sessionId)
      closeRef.current(true)
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

  const body = (() => {
    if (phase === 'loading') return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.loading'))
    if (phase === 'error' || plan === null) {
      return h(
        'div',
        { className: 'dsh-ckpt-hint' },
        h('div', null, failure === null ? translate('dialog.loadFailed') : failure),
        h(
          'button',
          { type: 'button', className: 'dsh-ckpt-button', style: { marginTop: '8px' }, onClick: () => setAttempt((n) => n + 1) },
          translate('dialog.retry'),
        ),
      )
    }
    if (revertable.length === 0) {
      return h('div', { className: 'dsh-ckpt-hint' }, translate('dialog.none'))
    }
    return h(
      'div',
      { className: 'dsh-ckpt-list' },
      files.map((file) =>
        h(
          'div',
          { key: file.path, className: 'dsh-ckpt-file' },
          h(
            'div',
            { className: 'dsh-ckpt-filerow' },
            h('span', { className: 'dsh-ckpt-name' }, h('code', { className: 'dsh-ckpt-path' }, file.path)),
            h(
              'span',
              { className: 'dsh-ckpt-badges' },
              file.action === 'unsupported'
                ? h('span', { className: 'dsh-ckpt-warn' }, translate('dialog.unsupported', { reason: translate(`dialog.reason.${file.reason}`) }))
                : null,
              file.action === 'delete' ? h('span', { className: 'dsh-ckpt-warn' }, translate('dialog.delete')) : null,
              typeof file.added === 'number' && file.added > 0 ? h('span', { className: 'dsh-ckpt-add' }, `+${file.added}`) : null,
              typeof file.deleted === 'number' && file.deleted > 0 ? h('span', { className: 'dsh-ckpt-del' }, `−${file.deleted}`) : null,
            ),
          ),
        ),
      ),
    )
  })()

  const footer = (() => {
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
          disabled: busy || phase !== 'ready',
          onClick: applyRevert,
        },
        toEnd ? translate('dialog.confirmEnd', { count: revertable.length }) : translate('dialog.confirm', { count: revertable.length }),
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
        h('span', { className: 'dsh-ckpt-icon', 'aria-hidden': 'true' }, '⟲'),
        h(
          'div',
          { className: 'dsh-ckpt-headings' },
          h('h2', { className: 'dsh-ckpt-title' }, title),
          h('p', { className: 'dsh-ckpt-sub' }, subtitle),
        ),
        h('button', { type: 'button', className: 'dsh-ckpt-close', 'aria-label': translate('dialog.close'), onClick: () => closeRef.current(false) }, '✕'),
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

/** Session → the cards that want to re-read its turn list. */
const turnsWatchers = new Map()

/**
 * Invalidate one Session's cached turn list and wake every card watching it.
 * A revert or forget changes what those cards should show, including the
 * "forgotten" badge of turns that were not the clicked one.
 * @param {string} sessionId - the conversation.
 */
function bumpTurns(sessionId) {
  turnsReads.delete(sessionId)
  const watchers = turnsWatchers.get(sessionId)
  if (watchers === undefined) return
  for (const watcher of [...watchers]) {
    try {
      watcher()
    } catch {
      // one card rerendering must not stop the others
    }
  }
}

/**
 * Subscribe one card to its Session's turn-list changes.
 * @param {string} sessionId - the conversation.
 * @param {() => void} listener - the re-read request.
 * @returns the unsubscribe function.
 */
function watchTurns(sessionId, listener) {
  let watchers = turnsWatchers.get(sessionId)
  if (watchers === undefined) {
    watchers = new Set()
    turnsWatchers.set(sessionId, watchers)
  }
  watchers.add(listener)
  return () => {
    watchers.delete(listener)
    if (watchers.size === 0) turnsWatchers.delete(sessionId)
  }
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

  // A forget can mark turns other than the clicked one, so every card refreshes.
  React.useEffect(() => {
    if (typeof sessionId !== 'string') return undefined
    return watchTurns(sessionId, () => setTick((value) => value + 1))
  }, [sessionId])

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
      entry.forgotten === true
        ? h('span', { style: FORGOTTEN, role: 'status', 'aria-label': translate('card.forgottenAria') }, translate('card.forgotten'))
        : isLatest
          ? h('button', { type: 'button', style: TRIGGER, onClick: () => setDialogSide('start') }, translate('card.undo'))
          : h('button', { type: 'button', style: TRIGGER, onClick: () => setDialogSide('end') }, translate('card.toEnd')),
    ),
    dialogSide === null
      ? null
      : h(RevertDialog, {
          sessionId,
          turn: turnNumber,
          side: dialogSide,
          latestTurn,
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
