import { readFileSync, writeFileSync } from 'node:fs'

// Extract the plugin body directly from the source file (previously this
// read an externally prepared /tmp/kg-client-body.js; self-contained now).
const srcClient = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const oldOpen = `  return {
    inject: ['slots', 'timer', 'sessions', 'inputTriggers'],
    async apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return`
const oldTail = `    },
  }
`
const openIdx = srcClient.indexOf(oldOpen)
const tailIdx = srcClient.lastIndexOf(oldTail)
if (openIdx < 0 || tailIdx <= openIdx) throw new Error('client source wrapper not found')
let c = srcClient.slice(openIdx, tailIdx + oldTail.length)

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
      if (method === "list-models") {
        const res = await fetch("/api/dsh-knowledge-graph/list-models", { cache: "no-store" })
        return res.json()
      }
      if (method === "document-import") {
        const res = await fetch("/api/dsh-knowledge-graph/document-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "candidate-list" || method === "candidate-update" || method === "document-load" || method === "image-load" || method === "document-export" || method === "graph-commit" || method === "graph-query" || method === "answer-graph" || method === "resume-extract" || method === "relation-retry") {
        const res = await fetch("/api/dsh-knowledge-graph/" + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
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
      if (method === "verify-graph") {
        const res = await fetch("/api/dsh-knowledge-graph/verify-graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "question-graph") {
        const res = await fetch("/api/dsh-knowledge-graph/question-graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "fact-check") {
        const res = await fetch("/api/dsh-knowledge-graph/fact-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "task-cancel") {
        const res = await fetch("/api/dsh-knowledge-graph/task-cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.json()
      }
      if (method === "task-status" || method === "trajectory-status") {
        const ep = method === "trajectory-status" ? "trajectory-status" : "task-status"
        const checkpoint = body && body.includeCheckpoint ? "&includeCheckpoint=1" : ""
        const res = await fetch("/api/dsh-knowledge-graph/" + ep + "?taskId=" + encodeURIComponent(body.taskId) + checkpoint, { cache: "no-store" })
        return res.json()
      }
      throw new Error("unsupported knowledge-graph RPC method: " + method)
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return`

// strip the dynamic wrapper:  return { inject, async apply(ctx) {
if (!c.includes(oldOpen)) throw new Error('client open block not found')
c = c.replace(oldOpen, header)

// styles.insert( -> insertStyles(
if (!c.includes('styles.insert(')) throw new Error('styles.insert not found')
c = c.split('styles.insert(').join('insertStyles(')

// host.call -> rpc
if (!c.includes("host.call('candidate-list'")) throw new Error('candidate-list call not found')
if (!c.includes("host.call('candidate-update'")) throw new Error('candidate-update call not found')
if (!c.includes("host.call('document-load'")) throw new Error('document-load call not found')
if (!c.includes("host.call('image-load'")) throw new Error('image-load call not found')
if (!c.includes("host.call('document-export'")) throw new Error('document-export call not found')
if (!c.includes("host.call('graph-commit'")) throw new Error('graph-commit call not found')
if (!c.includes("host.call('resume-extract'")) throw new Error('resume-extract call not found')
if (!c.includes("host.call('relation-retry'")) throw new Error('relation-retry call not found')
if (!c.includes("host.call('extract', payload)")) throw new Error('extract call not found')
if (!c.includes("host.call('task-status'")) throw new Error('task-status call not found')
if (!c.includes("host.call('trajectory-extract', { sessionId, ...(effectiveModelArg ? { model: effectiveModelArg } : {}) })")) throw new Error('trajectory-extract call not found')
if (!c.includes("host.call('trajectory-status'")) throw new Error('trajectory-status call not found')
if (!c.includes("host.call('append-extract', payload)")) throw new Error('append-extract call not found')
if (!c.includes("host.call('trajectory-append-extract'")) throw new Error('trajectory-append-extract call not found')
if (!c.includes("host.call('verify-graph'")) throw new Error('verify-graph call not found')
if (!c.includes("host.call('question-graph'")) throw new Error('question-graph call not found')
if (!c.includes("host.call('fact-check'")) throw new Error('fact-check call not found')
if (!c.includes("host.call('task-cancel'")) throw new Error('task-cancel call not found')
if (!c.includes("host.call('list-models'")) throw new Error('list-models call not found')
if (!c.includes("host.call('document-import'")) throw new Error('document-import call not found')
if (!c.includes("host.call('graph-query'")) throw new Error('graph-query call not found')
if (!c.includes("host.call('answer-graph'")) throw new Error('answer-graph call not found')
c = c.split("host.call('candidate-list'").join("rpc('candidate-list'")
c = c.split("host.call('candidate-update'").join("rpc('candidate-update'")
c = c.split("host.call('document-load'").join("rpc('document-load'")
c = c.split("host.call('image-load'").join("rpc('image-load'")
c = c.split("host.call('document-export'").join("rpc('document-export'")
c = c.split("host.call('graph-commit'").join("rpc('graph-commit'")
c = c.split("host.call('resume-extract'").join("rpc('resume-extract'")
c = c.split("host.call('relation-retry'").join("rpc('relation-retry'")
c = c.split("host.call('extract', payload)").join("rpc('extract', payload)")
c = c.split("host.call('task-status'").join("rpc('task-status'")
c = c.split("host.call('trajectory-extract', { sessionId, ...(effectiveModelArg ? { model: effectiveModelArg } : {}) })").join("rpc('trajectory-extract', { sessionId, ...(effectiveModelArg ? { model: effectiveModelArg } : {}) })")
c = c.split("host.call('trajectory-status'").join("rpc('trajectory-status'")
c = c.split("host.call('append-extract', payload)").join("rpc('append-extract', payload)")
c = c.split("host.call('trajectory-append-extract'").join("rpc('trajectory-append-extract'")
c = c.split("host.call('verify-graph'").join("rpc('verify-graph'")
c = c.split("host.call('question-graph'").join("rpc('question-graph'")
c = c.split("host.call('fact-check'").join("rpc('fact-check'")
c = c.split("host.call('task-cancel'").join("rpc('task-cancel'")
c = c.split("host.call('list-models'").join("rpc('list-models'")
c = c.split("host.call('document-import'").join("rpc('document-import'")
c = c.split("host.call('graph-query'").join("rpc('graph-query'")
c = c.split("host.call('answer-graph'").join("rpc('answer-graph'")
if (c.includes('host.call(')) throw new Error('unmapped host.call remains in persistent client build')
if (!c.includes("rpc('image-load'")) throw new Error('image-load RPC rewrite missing from persistent client')

// tail: close apply + module
if (!c.endsWith(oldTail)) throw new Error('client tail not found')
const tail = `    }

    exports.inject = ["slots", "timer", "sessions", "inputTriggers"];
    exports.apply = apply;
    return module.exports;
  }
});
`
c = c.slice(0, c.length - oldTail.length) + tail

writeFileSync(new URL('../lib/client.js', import.meta.url), c)
console.log('client written, lines:', c.split('\n').length)
