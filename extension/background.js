// DSH 划线拆图 — MV3 service worker.
// The content script runs on arbitrary pages where chrome.storage.session and
// chrome.action are NOT available; it forwards the selected text here, and the
// worker (which has full extension API access) stashes it and opens the popup.
'use strict'

chrome.runtime.onInstalled.addListener(() => {
  console.log('[dsh-kg-ext] installed')
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'kg-store-text') return
  const text = typeof msg.text === 'string' ? msg.text : ''
  const stash = () =>
    chrome.storage.session.set({ kgText: text }).then(() => {
      // Chrome 127+: openPopup() may be called while a user gesture from a
      // content-script click is still in flight (the message carries it).
      // The popup consumes kgText from storage.session on mount.
      return chrome.action.openPopup()
    })
  stash().catch(() => {
    // openPopup unavailable / not a gesture: fall back to a notification so
    // the user knows the text was captured and to click the toolbar icon.
    try {
      chrome.notifications.create('kg-hint', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: '已选中文本',
        message: '请点击浏览器工具栏的「DSH 划线拆图」图标查看知识图。',
      })
    } catch (e) { /* last resort: silent; text stays in storage.session */ }
  })
  sendResponse({ ok: true })
})
