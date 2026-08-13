# Repository operating guide

This repository owns the automotive photography publisher application and is
the public, copyright-retained media origin for
`https://tonytan.me/photography`. Read `PUBLISHING.md` before changing either
branch or the production workflow.

- `main` contains the publisher source and tests under `uploader/`, the gallery
  schema, documentation, and the repository-owned deployment workflow. Change
  it through a pull request; Tony may merge as repository administrator.
- `media` contains `gallery.json`, generated WebP previews, and displayable
  original photographs. Do not merge feature branches into `media`.
- The restricted GitHub App used by `tonytan.me/photography/manage` is the
  normal writer for `media`. It must stay private, keep only `Contents: write`,
  and be installed on this repository alone.
- Never commit GitHub App keys, OAuth tokens, AWS credentials, camera RAW
  masters, location data that Tony did not choose to publish, or unrelated
  project files.
- Published paths are immutable. A correction gets a new photo id; do not
  overwrite an existing original or preview.

The shared Caddy route, root-owned systemd service definition, validating root
deployer, and server recovery boundary remain in
`widmonstertony/Personal-Website`. They are infrastructure contracts, not
application source. A protected `main` release from this repository is the only
normal path that deploys the publisher implementation.
