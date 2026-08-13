#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PLUGIN_VERSION="1.2.835.0"
readonly EXPECTED_FINGERPRINT="7959637124CE093AD501D47A2C4D4AFF6F6757EE"
readonly DOWNLOAD_ROOT="https://s3.amazonaws.com/session-manager-downloads/plugin/${PLUGIN_VERSION}/ubuntu_64bit"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT

install -d -m 0700 "${work_dir}/gnupg"
export GNUPGHOME="${work_dir}/gnupg"

cat > "${work_dir}/aws-session-manager-signing-key.asc" <<'KEY'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mFIEZ5ERQxMIKoZIzj0DAQcCAwQjuZy+IjFoYg57sLTGhF3aZLBaGpzB+gY6j7Ix
P7NqbpXyjVj8a+dy79gSd64OEaMxUb7vw/jug+CfRXwVGRMNtIBBV1MgU1NNIFNl
c3Npb24gTWFuYWdlciA8c2Vzc2lvbi1tYW5hZ2VyLXBsdWdpbi1zaWduZXJAYW1h
em9uLmNvbT4gKEFXUyBTeXN0ZW1zIE1hbmFnZXIgU2Vzc2lvbiBNYW5hZ2VyIFBs
dWdpbiBMaW51eCBTaWduZXIgS2V5KYkBAAQQEwgAqAUCZ5ERQ4EcQVdTIFNTTSBT
ZXNzaW9uIE1hbmFnZXIgPHNlc3Npb24tbWFuYWdlci1wbHVnaW4tc2lnbmVyQGFt
YXpvbi5jb20+IChBV1MgU3lzdGVtcyBNYW5hZ2VyIFNlc3Npb24gTWFuYWdlciBQ
bHVnaW4gTGludXggU2lnbmVyIEtleSkWIQR5WWNxJM4JOtUB1HosTUr/b2dX7gIe
AwIbAwIVCAAKCRAsTUr/b2dX7rO1AQCa1kig3lQ78W/QHGU76uHx3XAyv0tfpE9U
oQBCIwFLSgEA3PDHt3lZ+s6m9JLGJsy+Cp5ZFzpiF6RgluR/2gA861M=
=2DQm
-----END PGP PUBLIC KEY BLOCK-----
KEY

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "${DOWNLOAD_ROOT}/session-manager-plugin.deb" \
  --output "${work_dir}/session-manager-plugin.deb"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "${DOWNLOAD_ROOT}/session-manager-plugin.deb.sig" \
  --output "${work_dir}/session-manager-plugin.deb.sig"

gpg --batch --import "${work_dir}/aws-session-manager-signing-key.asc"
actual_fingerprint="$(
  gpg --batch --with-colons --fingerprint |
    awk -F: '$1 == "fpr" { print $10; exit }'
)"
if [[ "${actual_fingerprint}" != "${EXPECTED_FINGERPRINT}" ]]; then
  printf 'Unexpected AWS signing key fingerprint: %s\n' "${actual_fingerprint}" >&2
  exit 1
fi

gpg --batch --verify \
  "${work_dir}/session-manager-plugin.deb.sig" \
  "${work_dir}/session-manager-plugin.deb"

if [[ "${VERIFY_ONLY:-0}" == "1" ]]; then
  exit 0
fi

sudo dpkg --install "${work_dir}/session-manager-plugin.deb"
session-manager-plugin --version
