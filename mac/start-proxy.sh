#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Open http://127.0.0.1:8082/login to sign in."
exec node --use-system-ca "$SCRIPT_DIR/proxy.js"
