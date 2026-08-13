# Publishing architecture

## Normal workflow

1. Tony opens `https://tonytan.me/photography/manage` and authenticates with
   the `widmonstertony` GitHub account.
2. The browser validates a JPEG, PNG, or WebP original (50 MiB maximum), reads
   its dimensions, and creates an 1800 px WebP contact-sheet preview.
3. The original and preview stream through the loopback-only publisher on the
   portfolio server. The service never writes image bytes to EC2 storage.
4. A private GitHub App stores the original as a raw asset on the
   `photography-originals-v1` release and writes the bounded preview under
   `previews/YYYY/` on `media`.
5. Only after both files exist does the service update `gallery.json`. The
   public portfolio then reads that manifest, downloads previews from
   `raw.githubusercontent.com`, and fetches a user-requested original from its
   GitHub Release Asset URL.

The OAuth user token is used once to verify Tony's login and is not saved. The
GitHub App installation token is short-lived and generated on demand. Durable
App credentials are mode `0600` on the server and never enter GitHub Actions.

## Application ownership and deployment

`uploader/` is the source of truth for the service listening on EC2 loopback
port 4030. Its tests run on every pull request. A protected `main` push packages
only `package.json`, `server.mjs`, `github.mjs`, and `policy.mjs`, records the
exact commit, and uploads the short-lived artifact to the private release
bucket under the `photography/` prefix.

GitHub exchanges its job identity for
`arn:aws:iam::749355576137:role/TonyTanDeployPhotography`. That role is trusted
only for this repository id, owner id, and `main` ref. The workflow opens an SSH
tunnel to the one production instance through the fixed-port SSM document, then
authenticates as the non-login `github-photography` account. Its forced command
can invoke only `deploy-tonytan-app photography`; the root boundary validates
the archive allowlist and delegates to the photography service deployer. The
deployer switches an immutable release, restarts only this service, checks
loopback health, and automatically restores the previous symlink on failure.

The central Caddy route, systemd unit, root deployers, sudo rule, and OIDC
CloudFormation definition remain in `widmonstertony/Personal-Website` because
they are shared production security infrastructure. The publisher source,
tests, and normal release workflow do not belong there.

For an application rollback, revert the bad change on a branch, open and merge
a new pull request, and let the new `main` commit deploy. Do not mutate an old
release directory or bypass the workflow. If the repository deployment
boundary itself is unavailable, use the reviewed recovery procedure in the
Personal-Website operations guide with the operator key; never copy that key
into this repository.

## Recovery

- If publishing fails before the manifest update, the photo is not public.
  Retrying the same draft safely reuses an uploaded release asset or immutable
  media file when its identity and size match.
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
