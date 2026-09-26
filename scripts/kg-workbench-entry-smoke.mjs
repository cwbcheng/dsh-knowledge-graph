import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Only global slots exist on an empty DSH home page. Conversation-scoped
// injections remain pending until a conversation is opened.
async function loadClient(file, persistent) {
  const entries = new Map(), injections = [], disposers = []
  const effects = [], listeners = new Map()
  const document = {
    activeElement: null,
    head: { appendChild() {} },
    createElement(tag) { assert.equal(tag, 'style'); return { setAttribute() {} } },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    querySelector(selector) { return selector === '.kg-sidebar-btn' ? document.launcher : null },
  }
  const element = (name, parent = null, dialog = false) => ({
    name, parent, dialog, isConnected: true, focusCalls: 0,
    focus(options) { assert.equal(options?.preventScroll, true); this.focusCalls++; document.activeElement = this },
    contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false },
    closest() { for (let node = this; node; node = node.parent) if (node.dialog) return node; return null },
  })
  document.body = element('body')
  document.launcher = element('launcher')
  document.activeElement = document.body
  const available = new Set(['shell.overlay', 'sidebar.footer.action'])
  const slots = {
    register(options, component) {
      const key = options.name + ':' + options.id
      assert(!entries.has(key), 'registrations must not replace another entry')
      const entry = { options, component }
      entries.set(key, entry)
      return () => { if (entries.get(key) === entry) entries.delete(key) }
    },
    inject(name, register) {
      const injection = { name, register }
      injections.push(injection)
      if (available.has(name)) disposers.push(register())
    },
  }
  const React = {
    createElement: (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat() }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }),
    useMemo: fn => fn(),
    useEffect(fn) { effects.push(fn) },
  }
  const forbidden = new Proxy({}, { get() { throw new Error('Opening the workbench must not access a conversation or model') } })
  const ctx = { get: name => name === 'slots' ? slots : forbidden, timeout: () => () => {} }
  const sandbox = { React, console, document, requestAnimationFrame: setTimeout, cancelAnimationFrame: clearTimeout,
    styles: { insert() {} }, host: forbidden,
    localStorage: { getItem: () => null }, window: { innerWidth: 1200, innerHeight: 800 } }
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  if (persistent) {
    sandbox.window.__ModuleLoader__ = { load({ factory }) { sandbox.plugin = factory(() => React) } }
    runInNewContext(source, sandbox)
    await sandbox.plugin.apply(ctx)
  } else {
    runInNewContext(source.replace('export default function clientPlugin()', 'function clientPlugin()') + ';globalThis.plugin = clientPlugin()', sandbox)
    await sandbox.plugin.apply(ctx)
  }
  const render = entry => entry.component({ wide: true })
  const unwrap = tree => { while (typeof tree?.tag === 'function') tree = tree.tag(tree.attrs); return tree }
  return { entries, injections, render, unwrap, document, element,
    mountWindow(entry) {
      effects.length = 0
      const tree = unwrap(render(entry)), surface = element('window', null, true), close = element('close', surface)
      const closeButton = find(tree, item => item.attrs['aria-label'] === '关闭工作台')
      surface.querySelector = selector => selector === '.kg-win-close' ? close : null
      tree.attrs.ref.current = surface
      const cleanups = effects.splice(0).map(fn => fn())
      return { surface, close, tree,
        closeWindow() { closeButton.attrs.onClick() },
        key(target, extras = {}) {
          const event = { key: 'Escape', target, currentTarget: surface, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extras }
          if (surface.contains(target)) tree.attrs.onKeyDown?.(event)
          if (!event.stopped) for (const fn of listeners.get('keydown') || []) fn(event)
          return event
        },
        unmount() {
          surface.isConnected = false; close.isConnected = false; tree.attrs.ref.current = null
          for (const cleanup of cleanups.reverse()) cleanup?.()
          assert.equal([...listeners.values()].reduce((sum, set) => sum + set.size, 0), 0, 'unmount must remove document listeners')
        },
      }
    },
    declare(name) { available.add(name); for (const entry of injections.filter(item => item.name === name)) disposers.push(entry.register()) },
    dispose() { for (const dispose of disposers.reverse()) dispose(); assert.equal(entries.size, 0) },
  }
}
const find = (tree, check) => !tree || typeof tree !== 'object' ? null : check(tree) ? tree : tree.children?.map(child => find(child, check)).find(Boolean)
for (const [file, persistent] of [['../src/index.client.js', false], ['../lib/client.js', true]]) {
  for (let reload = 0; reload < 2; reload++) {
    const ui = await loadClient(file, persistent)
    const launcher = ui.entries.get('sidebar.footer.action:kg-workbench-launcher')
    assert(launcher, file + ': the empty home page must have a global workbench entry')
    assert(!ui.injections.some(entry => entry.name === 'conversation.session.header.actions'), 'the document workbench no longer belongs to conversation headers')
    const overlay = ui.entries.get('shell.overlay:kg-workbench-window')
    assert(overlay)
    assert.equal(ui.unwrap(ui.render(overlay)), null)
    for (const wide of [true, false]) {
      const button = ui.unwrap(launcher.component({ wide }))
      assert.equal(button.tag, 'button')
      assert.equal(button.attrs['aria-label'], '打开知识图工作台')
      assert.equal(button.attrs['aria-haspopup'], 'dialog')
      assert.equal(button.attrs['aria-expanded'], false)
      assert.equal(button.attrs.title, '打开知识图工作台')
      assert.equal(Boolean(find(button, item => item.tag === 'span' && item.children.includes('知识图'))), wide)
      button.attrs.onClick()
      assert.equal(ui.unwrap(launcher.component({ wide })).attrs['aria-expanded'], true)
      const window = ui.unwrap(ui.render(overlay))
      assert.equal(window.attrs.role, 'dialog')
      assert(find(window, item => item.tag?.name === 'WorkbenchBody'), 'global entry must open the actual workbench, not create a chat')
      button.attrs.onClick()
      assert.equal(ui.unwrap(launcher.component({ wide })).attrs['aria-expanded'], true, 'repeated opening must not close an active workbench')
      find(window, item => item.attrs['aria-label'] === '关闭工作台').attrs.onClick()
      assert.equal(ui.unwrap(ui.render(overlay)), null)
    }
    ui.declare('conversation.view')
    assert(ui.entries.get('conversation.view:kg-trajectory'), 'session trajectory stays in its conversation')
    ui.dispose()
  }
}

// Mount the actual WindowInner effects without mounting WorkbenchBody or calling
// the Host. Browser checks separately cover real DOM focus and event propagation.
for (const [file, persistent] of [['../src/index.client.js', false], ['../lib/client.js', true]]) {
  const ui = await loadClient(file, persistent)
  const { document, element } = ui
  const launcher = ui.entries.get('sidebar.footer.action:kg-workbench-launcher')
  const overlay = ui.entries.get('shell.overlay:kg-workbench-window')
  const open = () => ui.unwrap(launcher.component({ wide: true })).attrs.onClick()
  const isOpen = () => ui.unwrap(launcher.component({ wide: true })).attrs['aria-expanded']
  for (const reason of ['escape', 'button', 'detached-opener', 'outside-close']) {
    const opener = element('opener'), outside = element('outside')
    document.activeElement = opener
    open()
    const win = ui.mountWindow(overlay)
    assert.equal(document.activeElement, win.close, file + ': opening must move keyboard focus into the workbench')
    const input = element('input', win.surface)
    document.activeElement = input
    open()
    assert.equal(document.activeElement, input, 'repeated opening must preserve a focused editor')
    document.activeElement = outside
    win.key(outside)
    assert.equal(isOpen(), true, 'Escape in another panel must not dismiss the non-modal workbench')
    open()
    assert.equal(document.activeElement, win.close, 'reopening an existing workbench from outside must focus it')
    for (const extras of [{ key: 'Enter' }, { defaultPrevented: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) {
      win.key(input, extras)
      assert.equal(isOpen(), true, 'child-handled keys and IME cancellation must not close the workbench')
    }
    const nestedDialog = element('inner-dialog', win.surface, true)
    win.key(element('inner-close', nestedDialog))
    assert.equal(isOpen(), true, 'a nested dialog owns its Escape key')
    if (reason === 'detached-opener') outside.isConnected = false
    if (reason === 'outside-close') document.activeElement = opener
    if (reason === 'escape') {
      const event = win.key(input)
      assert.equal(event.defaultPrevented, true)
      assert.equal(event.stopped, true, 'closing the workbench must not also dismiss the surrounding app')
    } else win.closeWindow()
    assert.equal(isOpen(), false)
    assert.equal(document.activeElement, reason === 'detached-opener' ? document.launcher : reason === 'outside-close' ? opener : outside,
      'restore the last connected opener only while the workbench owns focus')
    win.unmount()
  }
  document.activeElement = document.launcher
  open()
  const win = ui.mountWindow(overlay), outside = element('navigation-target')
  document.activeElement = outside
  const calls = win.close.focusCalls
  win.unmount()
  open()
  assert.equal(win.close.focusCalls, calls, 'disposed focus subscribers must never touch an old workbench')
  assert.equal(document.activeElement, outside, 'unmount must not steal navigation focus')
  ui.dispose()
}
console.log(JSON.stringify({ emptyHomeEntry: true, expandedAndCollapsed: true, singleWorkbench: true,
  noSessionOrModelAccess: true, trajectoryPreserved: true, dynamicAndPersistent: true, reloadDisposal: true,
  initialAndRepeatedFocus: true, focusRestoration: true, scopedEscape: true, childAndImeEscape: true, focusDisposal: true }))
