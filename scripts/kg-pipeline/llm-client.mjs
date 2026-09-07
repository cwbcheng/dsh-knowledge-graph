#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible chat client for the standalone extraction pipeline.
 *
 * Why not use DSH's own `ctx.get('llm')`? In a normal run the knowledge-graph
 * host plugin is loaded inside a live DSH session and receives the injected
 * `kgExtractor` / `llm` service. There is no public, standalone entry point for
 * "OCR a scanned PDF -> call the LLM -> emit a KnowledgeGraphDto", so the
 * closed loop is missing for scanned inputs. This module is that missing
 * client: it speaks the same schema the host's SYSTEM_PROMPT requires and talks
 * to any OpenAI-compatible endpoint identified by base URL + bearer key.
 *
 * It is deliberately small and dependency-free (Node 18+ global fetch), so it
 * can run from the repo without a build step.
 */

const DEFAULT_TIMEOUT_MS = 300000

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function envCredential() {
  // The DSH credentials file is YAML with a `refs` map; expose the bearer token
  // via an env var so we never print it. Prefer explicit env, else the DSH
  // credentials file.
  for (const name of ['KG_LLM_API_KEY', 'CODEX_PROXY_API_KEY', 'ZAI_API_KEY', 'SENSENOVA_API_KEY']) {
    if (process.env[name]) return process.env[name]
  }
  // fall back to reading ~/.dsh/.credentials.yaml (DSH home) for `refs`
  try {
    const candidates = [
      join(process.env.DSH_HOME || homedir(), '.dsh', '.credentials.yaml'),
      join(homedir(), '.dsh', '.credentials.yaml'),
    ]
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, 'utf8')
        // Light YAML refs parser: only need the `refs:` map.
        const refs = {}
        const inRefs = raw.split(/\n/).reduce((acc, line) => {
          if (/^refs:/.test(line)) acc.inRefs = true
          else if (/^\S/.test(line) && !/^\s/.test(line)) acc.inRefs = false
          if (acc.inRefs && (line.startsWith('  ') || line.startsWith('\t'))) {
            const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.+)\s*$/)
            if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, '')
          }
          return acc
        }, { inRefs: false })
        for (const name of ['KG_LLM_API_KEY', 'CODEX_PROXY_API_KEY', 'ZAI_API_KEY', 'SENSENOVA_API_KEY']) {
          if (refs[name]) return refs[name]
        }
      } catch (e) { /* try next */ }
    }
  } catch (e) { /* ignore */ }
  return ''
}

async function modelInfo() {
  // Resolve base URL + model from env; otherwise use sensible defaults matching
  // the DSH profile that has a working local provider.
  const baseURL = process.env.KG_LLM_BASE_URL || 'http://192.168.3.252:8317/v1'
  const model = process.env.KG_LLM_MODEL || 'gpt-5.6-sol'
  const apiKey = envCredential()
  return { baseURL, model, apiKey }
}

function extractJson(raw) {
  let s = String(raw || '').trim()
  // Strip markdown fences on their own lines.
  s = s.split('\n').filter((line) => !line.trim().startsWith('```')).join('\n')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('没有找到 JSON 对象（前 180 字：' + s.replace(/\s+/g, ' ').slice(0, 180) + '）')
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch (firstErr) {
    const candidates = [s, s.replace(/,\s*$/, '') + ']}', s + '}', s + ']}']
    for (const c of candidates) {
      try { return JSON.parse(c) } catch (e) { /* try next */ }
    }
    throw firstErr
  }
}

/**
 * Call the model with a system prompt + user text and return parsed JSON.
 * Uses the OpenAI /v1/chat/completions shape which is the most widely
 * compatible; responses are read into a single buffer.
 */
export async function callLLM({ system, user, maxTokens = 8000, temperature = 0.2, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { baseURL, model, apiKey } = await modelInfo()
  if (!apiKey) throw new Error('缺少 LLM API key；请设置 KG_LLM_API_KEY 或提供 ~/.dsh/.credentials.yaml 中的 provider key')
  const url = baseURL.replace(/\/$/, '') + '/chat/completions'
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    throw new Error('LLM 请求失败：' + (err && err.message ? err.message : String(err)))
  }
  clearTimeout(timer)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error('LLM HTTP ' + response.status + ': ' + body.slice(0, 300))
  }
  const data = await response.json()
  const content = data && data.choices && data.choices[0]
    ? (data.choices[0].message && typeof data.choices[0].message.content === 'string' ? data.choices[0].message.content : '')
    : ''
  return extractJson(content)
}
