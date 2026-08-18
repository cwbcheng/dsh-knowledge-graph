# Security notes

## Chrome extension signing key

The original `dist/dsh-knowledge-graph.pem` was committed and must be treated as
compromised. It is no longer used. A replacement CRX has been built with a new
signing identity; the replacement private key is kept outside the repository.
Existing installations signed by the old key must be reinstalled because the
extension ID changes when the key changes.

Keep the replacement key outside the checkout, with restrictive permissions
(for example `~/.config/dsh-knowledge-graph/extension-signing.pem`, mode `0600`),
and use `npm run pack:extension` with `DSH_KG_EXTENSION_KEY` when rebuilding.
Never copy the key into `dist/` or commit it.

The checked-out branch still contains the old key in historical commits. A
repository administrator should coordinate a history rewrite before force-pushing
it to a shared remote, then ask collaborators to reclone or reset their clones:

```bash
git filter-repo --path dist/dsh-knowledge-graph.pem --invert-paths
git push --force-with-lease --all origin
git push --force-with-lease --tags origin
```

History rewriting does not replace key rotation; both steps are required.
