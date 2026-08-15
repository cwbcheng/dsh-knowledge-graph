// DSH 划线拆图 — content script: detect text selection on ANY page and offer
// a floating "拆成知识图" button. Clicking it stashes the selected text and
// opens the extension popup (Chrome 127+ chrome.action.openPopup; older
// Chrome falls back to a hint that the user should click the toolbar icon).
(() => {
  'use strict'
  const MAX_SELECT = 20000
  let btn = null

  const isEditable = (el) => {
    if (!el) return false
    const t = el.tagName
    return t === 'TEXTAREA' || t === 'INPUT' || t === 'SELECT' || el.isContentEditable
  }
  const hideBtn = () => {
    if (btn) { btn.remove(); btn = null }
  }
  const showBtn = (rect, text) => {
    hideBtn()
    btn = document.createElement('div')
    btn.textContent = '拆成知识图'
    Object.assign(btn.style, {
      position: 'fixed',
      zIndex: 2147483646,
      cursor: 'pointer',
      background: '#3b82f6',
      color: '#ffffff',
      border: 'none',
      borderRadius: '8px',
      padding: '6px 12px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
      userSelect: 'none',
    })
    btn.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 130)) + 'px'
    btn.style.top = Math.max(8, rect.top - 40) + 'px'
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', async () => {
      hideBtn()
      // chrome.storage.session / chrome.action are NOT available in content
      // scripts on arbitrary pages — forward to the service worker, which
      // stashes the text and opens the popup (Chrome 127+).
      try {
        await chrome.runtime.sendMessage({ type: 'kg-store-text', text })
      } catch (e) {
        // Worker unreachable: stash into storage.local as a last resort; the
        // popup also checks local when session is empty.
        try { await chrome.storage.local.set({ kgText: text }) } catch (e2) {}
      }
    })
    document.documentElement.appendChild(btn)
  }

  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection()
      const t = sel ? sel.toString().trim() : ''
      if (!t || t.length > MAX_SELECT) { hideBtn(); return }
      const anchor = sel.anchorNode
      const el = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor
      if (el && isEditable(el)) { hideBtn(); return }
      let rect = null
      try {
        if (sel.rangeCount > 0) rect = sel.getRangeAt(0).getBoundingClientRect()
      } catch (e) {}
      if (!rect || (!rect.width && !rect.height)) { hideBtn(); return }
      showBtn(rect, t)
    }, 10)
  })

  document.addEventListener('mousedown', (e) => {
    if (btn && !btn.contains(e.target)) hideBtn()
  })
  window.addEventListener('scroll', hideBtn, true)
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection()
    if (!sel || !sel.toString().trim()) hideBtn()
  })
})()
