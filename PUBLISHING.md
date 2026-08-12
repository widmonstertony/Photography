# Publishing architecture

## Normal workflow

1. Tony opens `https://tonytan.me/photography/manage` and authenticates with
   the `widmonstertony` GitHub account.
2. The browser validates a JPEG, PNG, or WebP original (50 MiB maximum), reads
   its dimensions, and creates an 1800 px WebP contact-sheet preview.
3. The original and preview stream through the loopback-only publisher on the
   portfolio server. The service never writes image bytes to EC2 storage.
4. A private GitHub App writes immutable files under `originals/YYYY/` and
   `previews/YYYY/` on `media`.
5. Only after both files exist does the service update `gallery.json`. The
   public portfolio then reads that manifest and downloads previews or
   user-requested originals directly from `raw.githubusercontent.com`.

The OAuth user token is used once to verify Tony's login and is not saved. The
GitHub App installation token is short-lived and generated on demand. Durable
App credentials are mode `0600` on the server and never enter GitHub Actions.

## Recovery

- If publishing fails before the manifest update, the photo is not public.
  Retrying the same draft safely reuses same-size immutable files.
- If the GitHub App is removed, reinstall it on **only** this Photography
  repository. Never broaden its repository selection or permissions.
- If App credentials are compromised, revoke/delete the App in GitHub, remove
  `/var/lib/tonytan-photography/github-app.json` on the server through a
  reviewed recovery session, rerun the one-time setup, and verify the exact
  repository installation before publishing.
- Keep camera RAW masters and the primary photo backup outside GitHub. This
  repository is a public presentation copy, not the only archival backup.

## Capacity

Previews keep ordinary page loads small, while originals remain available on
demand. Git history retains binary objects permanently, so monitor repository
size and publish curated work rather than complete camera rolls. If the media
archive approaches GitHub's practical repository limits, migrate the media
origin deliberately and update the manifest contract; do not silently add Git
LFS or a second storage provider.
