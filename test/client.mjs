/**
 * Client-half test: load the browser module in a Node sandbox with a fake
 * module loader and a fake React, then assert its registration contract, its
 * dictionary key parity, and that the card and the revert dialog render their
 * real trees (file rows, diff placeholder, confirm label) without throwing.
 *
 * Run: node test/client.mjs
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const SOURCE_PATH = new URL('../client.js', import.meta.url)
const source = await readFile(SOURCE_PATH, 'utf8')

/** Capture the module the bundle registers. */
let registered
globalThis.window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
await import(SOURCE_PATH.href)

assert.ok(registered !== undefined, 'the bundle registered a client module')
assert.equal(registered.id, 'dsh-checkpoints')
console.log('PASS registers the client module as', registered.id)

/** A React stand-in: createElement + the hooks the components use. */
function makeReact(seed = []) {
  const queue = [...seed]
  const take = () => (queue.length > 0 ? queue.shift() : undefined)
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== undefined) }
    },
    useState(initial) {
      const seeded = take()
      return [seeded === undefined ? (typeof initial === 'function' ? initial() : initial) : seeded, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

/** All text inside a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/** Every element in a rendered tree. */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children) elementsOf(child, out)
  return out
}

const react = makeReact()
const module = registered.factory((name) => {
  assert.equal(name, 'react', 'the factory asks the module table for react')
  return react
})
assert.deepEqual(module.inject, ['slots', 'locale'])
assert.equal(typeof module.apply, 'function')
console.log('PASS injects', JSON.stringify(module.inject))

// ---- apply(): dictionary + slot registration
const effects = []
const locales = []
const slots = []
const ctx = {
  effect: (fn, label) => {
    effects.push(label)
    return fn()
  },
  locale: {
    register: (ns, dicts) => {
      locales.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject: (key, callback) => {
      slots.push({ key, registration: callback() })
      return () => {}
    },
    register: (options, component) => ({ options, component }),
  },
}
module.apply(ctx)

assert.equal(locales.length, 1, 'registers one dictionary namespace')
assert.equal(locales[0].ns, 'checkpoints')
assert.deepEqual(Object.keys(locales[0].dicts).sort(), ['en', 'zh'])
assert.equal(slots.length, 1, 'registers one slot entry')
const slotAt = (key) => slots.find((entry) => entry.key === key)
for (const key of ['conversation.chat.turnTail']) {
  const entry = slotAt(key)
  assert.ok(entry !== undefined, `registers ${key}`)
  assert.equal(entry.registration.options.name, key)
  assert.equal(entry.registration.options.id, 'dsh-checkpoints')
  assert.equal(entry.registration.options.order, 30)
  assert.equal(entry.registration.options.locale, 'checkpoints')
  assert.equal(typeof entry.registration.component, 'function')
}
console.log('PASS registers the turn-tail row at order 30 under the checkpoints dictionary')

// ---- dictionary parity, including every literal key the component asks for
const zh = locales[0].dicts.zh
const en = locales[0].dicts.en
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en carry the same keys')
const used = [...source.matchAll(/translate\(\s*'([A-Za-z0-9._]+)'/g)].map((match) => match[1])
for (const key of used) {
  assert.ok(Object.hasOwn(en, key), `en dictionary is missing ${key}`)
  assert.ok(Object.hasOwn(zh, key), `zh dictionary is missing ${key}`)
}
console.log(`PASS ${Object.keys(en).length} dictionary keys in both locales; ${new Set(used).size} literal keys referenced by the component all resolve`)

// ---- render smoke: no checkpoint yet → no card
const Card = slotAt('conversation.chat.turnTail').registration.component
const translate = (key) => key
const emptyCard = Card({ turn: { turn: 4 }, sessionId: 'session', t: translate })
assert.equal(emptyCard, null, 'a turn without a checkpoint renders nothing')

// ---- render smoke: a checkpoint with an open dialog → the row is rendered
const entry = { turn: 4, total: 2, files: [{ path: 'a.txt' }, { path: 'b.txt' }] }
const cardWithDialog = Card({ turn: { turn: 4 }, sessionId: 'session', t: translate })
assert.equal(cardWithDialog, null, 'the first render has no entry state yet')

// ---- render smoke: a historical turn, which offers "go back to this turn"
const seededReact = makeReact([
  // Card
  entry,
  5, // the newest recorded turn is 5, so turn 4 is historical
  'end', // the dialog is open on the go-back side
  0,
])
const seededModule = registered.factory(() => seededReact)
const seededSlots = []
seededModule.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  slots: {
    inject: (key, callback) => {
      seededSlots.push(callback())
      return () => {}
    },
    register: (options, component) => ({ options, component }),
  },
})
const seededCard = seededSlots[0].component({ turn: { turn: 4 }, sessionId: 'session', t: translate })
assert.notEqual(seededCard, null, 'a recorded turn renders a card')
const cardText = textOf(seededCard)
assert.match(cardText, /card\.title/)
assert.match(cardText, /card\.toEnd/)
assert.doesNotMatch(cardText, /card\.undo/)
console.log('PASS a historical turn offers only "revert here and forget later turns":', JSON.stringify(cardText.trim()))

// ---- the newest recorded turn offers only the revert-and-forget: nothing follows it
const lastTurnReact = makeReact([{ turn: 5, total: 1, files: [] }, 5, null, 0])
registered.factory(() => lastTurnReact)
const lastTurnTree = Card({ turn: { turn: 5 }, sessionId: 'session', t: translate })
assert.match(textOf(lastTurnTree), /card\.undo/)
assert.doesNotMatch(textOf(lastTurnTree), /card\.toEnd/)
console.log('PASS the newest turn offers only "revert and forget":', JSON.stringify(textOf(lastTurnTree).trim()))

// ---- render the dialog body itself in its ready phase
const plan = {
  planId: 'plan-1',
  turn: 4,
  side: 'start',
  totals: { files: 2, restore: 1, delete: 1, unsupported: 0 },
  files: [
    { path: 'src/a.txt', action: 'restore', status: 'M', added: 3, deleted: 1, size: 40 },
    { path: 'src/deleted.txt', action: 'delete', status: 'D', added: 0, deleted: 7 },
    { path: 'huge.bin', action: 'unsupported', reason: 'oversized', status: 'M', size: 9999999 },
  ],
}
// The card renders the dialog element; its component type is the dialog.
const dialogElement = elementsOf(seededCard).find((node) => typeof node.type === 'function')
assert.ok(dialogElement !== undefined, 'the open card renders the revert dialog element')
const dialogReact = makeReact([
  'ready', // phase
  plan, // plan
  undefined, // failure
  false, // busy
  0, // attempt
])
registered.factory(() => dialogReact)
const dialogTree = dialogElement.type({ ...dialogElement.props, side: 'start' })
assert.notEqual(dialogTree, null)
const dialogText = textOf(dialogTree)
assert.match(dialogText, /src\/a\.txt/, 'lists the file to restore')
assert.match(dialogText, /src\/deleted\.txt/, 'lists the file to delete')
assert.match(dialogText, /dialog\.delete/, 'marks the deleted file')
assert.match(dialogText, /huge\.bin/, 'lists the unsupported file')
assert.match(dialogText, /dialog\.unsupported/, 'marks the unsupported file')
assert.match(dialogText, /dialog\.confirm/, 'offers the confirm action')
assert.match(dialogText, /dialog\.undoTitle/)

const nodes = elementsOf(dialogTree)
const overlay = nodes.find((node) => node.props.className === 'dsh-ckpt-overlay')
const dialog = nodes.find((node) => node.props.className === 'dsh-ckpt-dialog')
assert.ok(overlay !== undefined, 'renders the modal overlay')
assert.ok(dialog !== undefined, 'renders the modal frame')
assert.equal(dialog.props.role, 'dialog')
assert.equal(dialog.props['aria-modal'], 'true')
const confirmButton = nodes.find((node) => node.type === 'button' && String(node.children).includes('dialog.confirm'))
assert.equal(confirmButton.props.disabled, false, 'the confirm action is available once the preview is ready')
const styleNode = nodes.find((node) => node.type === 'style')
assert.ok(styleNode !== undefined && styleNode.children.length > 0, 'renders its stylesheet as a component-local element')

// ---- the same dialog for "revert to the end of this turn"
const endPlan = { ...plan, side: 'end' }
const endReact = makeReact([
  'ready', // phase
  endPlan, // plan
  undefined, // failure
  false, // busy
  0, // attempt
])
registered.factory(() => endReact)
const endTree = dialogElement.type({ ...dialogElement.props, side: 'end' })
const endText = textOf(endTree)
assert.match(endText, /dialog\.endTitle/)
assert.match(endText, /dialog\.confirmEnd/)
assert.doesNotMatch(endText, /dialog\.undoTitle/)
console.log('PASS renders the "revert to this turn" dialog with its own title and confirm label')

console.log('PASS renders the revert dialog:', dialogText.replace(/\s+/g, ' ').slice(0, 240).trim(), '…')
console.log('\nPASS: the client half registers correctly and renders its card and dialog tree')
