import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Only global slots exist on an empty DSH home page. Conversation-scoped
// injections remain pending until a conversation is opened.
async function loadClient(file, persistent) {
  const entries = new Map(), injections = [], disposers = []
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
    useEffect() {},
  }
  const forbidden = new Proxy({}, { get() { throw new Error('Opening the workbench must not access a conversation or model') } })
  const ctx = { get: name => name === 'slots' ? slots : forbidden, timeout: () => () => {} }
  const sandbox = { React, console, requestAnimationFrame: setTimeout, cancelAnimationFrame: clearTimeout,
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
  return { entries, injections, render, unwrap,
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
console.log(JSON.stringify({ emptyHomeEntry: true, expandedAndCollapsed: true, singleWorkbench: true,
  noSessionOrModelAccess: true, trajectoryPreserved: true, dynamicAndPersistent: true, reloadDisposal: true }))
