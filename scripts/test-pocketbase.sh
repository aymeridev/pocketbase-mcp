#!/usr/bin/env bash
# Starts a throwaway PocketBase on 127.0.0.1:8090 for the integration tests.
# Usage: scripts/test-pocketbase.sh   (then: PB_TEST_URL=... npm run test:integration)
set -euo pipefail

PB_VERSION="${PB_VERSION:-0.40.4}"
PB_DIR="${PB_DIR:-.pb}"
PB_BIN="${PB_BIN:-$PB_DIR/pocketbase}"
EMAIL="${PB_TEST_EMAIL:-admin@example.com}"
PASSWORD="${PB_TEST_PASSWORD:-password123456}"

mkdir -p "$PB_DIR"
if [ ! -x "$PB_BIN" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux_amd64 ;;
    Linux-aarch64) platform=linux_arm64 ;;
    Darwin-arm64) platform=darwin_arm64 ;;
    Darwin-x86_64) platform=darwin_amd64 ;;
    *) echo "Unsupported platform, set PB_BIN to a PocketBase binary" >&2; exit 1 ;;
  esac
  curl -fsSL -o "$PB_DIR/pb.zip" \
    "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${platform}.zip"
  unzip -o -q "$PB_DIR/pb.zip" pocketbase -d "$PB_DIR"
  rm "$PB_DIR/pb.zip"
fi

"$PB_BIN" superuser upsert "$EMAIL" "$PASSWORD" --dir="$PB_DIR/data"
"$PB_BIN" serve --http=127.0.0.1:8090 --dir="$PB_DIR/data" > "$PB_DIR/pocketbase.log" 2>&1 &

for _ in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8090/api/health > /dev/null; then
    echo "PocketBase ${PB_VERSION} running on http://127.0.0.1:8090 (superuser: $EMAIL)"
    exit 0
  fi
  sleep 1
done
echo "PocketBase did not start, see $PB_DIR/pocketbase.log" >&2
exit 1
