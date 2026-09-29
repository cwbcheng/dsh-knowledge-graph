import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

for (const file of ['../src/index.client.js', '../lib/client.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = source.indexOf('function WorkbenchTabs(')
  const end = source.indexOf('function WorkbenchBody(', start)
  assert(start >= 0 && end > start, file + ': workspace navigation is missing')
  const h = (type, props, ...children) => ({ type, props, children: children.flat() })
  const changes = [], focus = []
  const Tabs = new Function('h', source.slice(start, end) + '; return WorkbenchTabs')(h)
  const tree = Tabs({ value: 'read', onChange: tab => changes.push(tab), reviewCount: 1647 })
  assert.equal(tree.props.role, 'tablist')
  const tabs = tree.children
  assert.equal(tabs.length, 4)
  assert.equal(tabs.filter(tab => tab.props.tabIndex === 0).length, 1)
  assert.equal(tabs.filter(tab => tab.props['aria-selected']).length, 1)
  assert.equal(tabs[2].props['aria-controls'], 'kg-workspace-review')
  const event = key => ({ key, preventDefault() {}, currentTarget: { parentElement: {
    querySelector(selector) { return { focus() { focus.push(selector) } } },
  } } })
  tabs[0].props.onKeyDown(event('ArrowLeft'))
  assert.equal(changes.at(-1), 'source', 'left arrow wraps rather than falling outside the tablist')
  tabs[3].props.onKeyDown(event('Home'))
  assert.equal(changes.at(-1), 'read')
  tabs[0].props.onKeyDown(event('End'))
  assert.equal(changes.at(-1), 'source')
  tabs[1].props.onClick()
  assert.equal(changes.at(-1), 'use')
  assert.equal(focus.length, 3)
  for (const tab of tabs) {
    assert.equal(tab.props.role, 'tab')
    assert.equal(tab.props.type, 'button')
  }
  assert.match(source, /className: 'kg-workspace-panel', hidden: workspaceTab !== 'read'/)
  assert.match(source, /className: 'kg-workspace-panel', hidden: workspaceTab !== 'use'/)
  assert.match(source, /className: 'kg-workspace-panel', hidden: workspaceTab !== 'review'/)
  assert.match(source, /hidden: !!resultView && workspaceTab !== 'source'/)
  assert.match(source, /\.kg-workbench \[hidden\] \{ display: none !important; \}/)
}
console.log(JSON.stringify({ workspaceTabs: true, rovingKeyboard: true, hiddenNotUnmounted: true, generatedParity: true }))
