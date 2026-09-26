# Global Workbench Entry

The document workbench was independent of Sessions, but its launcher was
registered in `conversation.session.header.actions`. An empty DSH home did
not declare that slot, so users had to open a conversation to reach it.

The launcher now uses root-scoped `sidebar.footer.action`, above Settings.
It opens the existing singleton floating workbench. Expanded sidebars show
the icon and label; collapsed sidebars show the same labelled icon button.
The button has a tooltip, keyboard focus styling and dialog expanded state.
The conversation-bound `kg-trajectory` tab and attachment import are unchanged.
Storage keys, document identities, task handling and review records are unchanged.

## Verification

- Negative control: the new empty-home regression failed against the old
  registration with `the empty home page must have a global workbench entry`.
- `npm run test:kg-entry` covers source and generated client, global slots
  without a conversation, both sidebar widths, idempotent opening, closing,
  trajectory registration, no Session/model access and registration disposal.
- Full WSL Node 24 `npm test` passed, including the new regression and packaging
  parity. Output: `output/global-entry-npm-test.log`.
- Existing external extension signing identity was reused to update the CRX
  after regenerated viewer CSS changed. No packaging gate was disabled.
- Real DSH composition used `scripts/dev-web.sh`, a fresh `kg-entry` profile,
  port 3119, and a temporary DSH home and SQLite database. No API key was added.
- Browser checks: zero Sessions; open from the empty home, expanded/collapsed
  sidebar, and Plugins panel; keyboard activation; close/reopen with the
  unsubmitted text draft intact; 390 x 844 mobile layout.
- A synthetic stored document with two nodes, one relation and a review issue
  loaded from History without a conversation. After closing, reopening and
  refreshing, the source, graph and review record were restored. Its revision
  stayed at 1 and its loaded-document SHA-256 stayed
  `64a7b5d1347c97ebddab87318a510dc1a578f1f8b9ea784d52e78626efb9c123`.
- Browser routing blocked graph mutations and model/task-start endpoints.
  Production graph data was not used for browser tests.
- Screenshots are in `output/playwright/global-entry-*.png`.

## Initial Verification State

Initial verification used `codex/kg-audit-continuation-20260926`. No commit,
push, merge or restart was part of that verification. Production 3099 retained
MainPID 1948968 and its 2026-09-26 19:47:36 CST start time.
