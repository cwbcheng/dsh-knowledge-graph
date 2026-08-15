import { readFileSync, writeFileSync } from 'node:fs'

let c = readFileSync('/tmp/kg-client-body.js', 'utf8')

const header = `/**
 * dsh-knowledge-graph — persistent client half (browser __ModuleLoader__ module).
 *
 * Mirrors src/index.client.js (dynamic-package format) for the persistent
 * install: same UI, but CSS is injected manually and RPC goes over fetch() to
 * the host webServer route instead of the package-private host.call. Keep UI
 * logic in sync with src/index.client.js.
 */
window.__ModuleLoader__.load({
  id: "dsh-knowledge-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    // ---------- CSS injection (no \`styles\` closure in composition mode) ----------
    const CSS_TAG_ID = "dsh-knowledge-graph"
    function insertStyles(cssText) {
      if (typeof document === "undefined") return
      const selector = "style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]"
      if (document.querySelector(selector) !== null) return
      const el = document.createElement("style")
      el.setAttribute("data-plugin-css", JSON.stringify(CSS_TAG_ID))
      el.textContent = cssText
      document.head.appendChild(el)
    }

    // ---------- RPC to the host half (webServer route, replaces host.call) ----------
    async function rpc(method, body) {
      if (method === "extract") {
        const res = await fetch("/api/dsh-knowledge-graph/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "trajectory-extract") {
        const res = await fetch("/api/dsh-knowledge-graph/trajectory-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "trajectory-append-extract") {
        const res = await fetch("/api/dsh-knowledge-graph/trajectory-append-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "append-extract") {
        const res = await fetch("/api/dsh-knowledge-graph/append-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      const ep = method === "trajectory-status" ? "trajectory-status" : "task-status"
      const res = await fetch("/api/dsh-knowledge-graph/" + ep + "?taskId=" + encodeURIComponent(body.taskId), { cache: "no-store" })
      return res.json()
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return`

// strip the dynamic wrapper:  return { inject, async apply(ctx) {
const oldOpen = `  return {
    inject: ['timer'],
    async apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return`
if (!c.includes(oldOpen)) throw new Error('client open block not found')
c = c.replace(oldOpen, header)

// styles.insert( -> insertStyles(
if (!c.includes('styles.insert(')) throw new Error('styles.insert not found')
c = c.split('styles.insert(').join('insertStyles(')

// host.call -> rpc
if (!c.includes("host.call('extract', payload)")) throw new Error('extract call not found')
if (!c.includes("host.call('task-status', { taskId })")) throw new Error('task-status call not found')
if (!c.includes("host.call('trajectory-extract', { sessionId })")) throw new Error('trajectory-extract call not found')
if (!c.includes("host.call('trajectory-status', { taskId })")) throw new Error('trajectory-status call not found')
if (!c.includes("host.call('append-extract', payload)")) throw new Error('append-extract call not found')
if (!c.includes("host.call('trajectory-append-extract', { sessionId, existing })")) throw new Error('trajectory-append-extract call not found')
c = c.split("host.call('extract', payload)").join("rpc('extract', payload)")
c = c.split("host.call('task-status', { taskId })").join("rpc('task-status', { taskId })")
c = c.split("host.call('trajectory-extract', { sessionId })").join("rpc('trajectory-extract', { sessionId })")
c = c.split("host.call('trajectory-status', { taskId })").join("rpc('trajectory-status', { taskId })")
c = c.split("host.call('append-extract', payload)").join("rpc('append-extract', payload)")
c = c.split("host.call('trajectory-append-extract', { sessionId, existing })").join("rpc('trajectory-append-extract', { sessionId, existing })")

// tail: close apply + module
const oldTail = `    },
  }
`
if (!c.endsWith(oldTail)) throw new Error('client tail not found')
const tail = `    }

    exports.inject = ["slots", "timer"];
    exports.apply = apply;
    return module.exports;
  }
});
`
c = c.slice(0, c.length - oldTail.length) + tail

writeFileSync('/mnt/d/github/dsh-knowledge-graph/lib/client.js', c)
console.log('client written, lines:', c.split('\n').length)
