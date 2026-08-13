# Tony Tan Automotive Photography

This public repository owns the publisher service and media origin for the
automotive photography portfolio at `https://tonytan.me/photography`.

- `main` contains the Node.js publisher under `uploader/`, its tests, the media
  contract, operating documentation, and independent CI/CD.
- `media` contains the published gallery manifest, browser previews, and
  legacy browser originals. Current original-resolution photographs are raw
  assets on the repository's `photography-originals-v1` release.
- The upload service at `tonytan.me` is the only supported writer for `media`.
- The portfolio downloads images directly from GitHub; AWS does not retain the
  photograph files.

## Rights

All photographs are © Xinpei "Tony" Tan. All rights reserved. The public URLs
allow portfolio viewing and explicitly offered downloads; they do not grant a
license to reproduce, redistribute, train models on, or commercially use the
work.

## Media policy

Published browser originals must be JPEG, PNG, or WebP, at most 50 MiB per
file. Camera RAW and HEIC masters stay in the photographer's separate backup
workflow because browsers cannot reliably display them. Files are immutable:
replace a photograph by publishing a new id rather than overwriting a path.

The gallery manifest follows [`schemas/gallery.schema.json`](schemas/gallery.schema.json).
The end-to-end upload, security, recovery, and capacity model is documented in
[`PUBLISHING.md`](PUBLISHING.md).

## Development

The publisher has no third-party runtime dependencies. Use Node.js 24 or newer:

```text
cd uploader
npm test
```

Open a pull request into protected `main`. Pull requests test the publisher and
scan for committed credentials. A merge to `main` builds an immutable four-file
service release and deploys it through the Photography repository's own
short-lived GitHub OIDC role and forced-command SSH account. No AWS access key,
server operator key, GitHub App private key, or photograph is stored in Actions.
