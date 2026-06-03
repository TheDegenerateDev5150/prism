#!/usr/bin/env bash
# Generates /tmp/prism-test-cert.{crt,key} for the nginx TLS fixture.
# Idempotent: skips if both files already exist.
set -euo pipefail

CERT=/tmp/prism-test-cert.crt
KEY=/tmp/prism-test-cert.key

if [[ -f "$CERT" && -f "$KEY" ]]; then
  echo "prism-test-cert already exists, skipping."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out    "$CERT" \
  -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Generated: $CERT  $KEY"
