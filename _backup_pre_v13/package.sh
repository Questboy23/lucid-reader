#!/usr/bin/env bash
# Build the Chrome Web Store zip: everything the extension needs, nothing else.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(node -p "require('./manifest.json').version")
OUT="lucid-reader-$VER.zip"
rm -f "$OUT"
zip -qr "$OUT" \
  manifest.json background.js README.md \
  icons options reader vendor fonts \
  -x '*.DS_Store' '*/.*' '*.map'
echo "$OUT  $(du -h "$OUT" | cut -f1)"
unzip -l "$OUT" | tail -1
