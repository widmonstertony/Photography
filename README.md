# Tony Tan Automotive Photography

This public repository is the media origin for the automotive photography
portfolio at `https://tonytan.me/photography`.

- `main` contains the media contract and operating documentation.
- `media` contains the published gallery manifest, browser previews, and
  original-resolution web photographs.
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
