#!/usr/bin/env bash
# Download official Node builds and run bin/probe-runtime.js against each.
#
# The point is to find the floor: the oldest and newest Node majors that survive
# on this CPU. Answers R1 in docs/plan.md. Writes nothing outside $WORKDIR.
#
#   ./bin/probe-node-matrix.sh                    majors 18 20 22 24 26
#   ./bin/probe-node-matrix.sh 18 20              just those
#   WORKDIR=/var/tmp/np ./bin/probe-node-matrix.sh

set -uo pipefail   # deliberately not -e: a crashing node is the result, not an abort

WORKDIR="${WORKDIR:-/tmp/peasant-nodeprobe}"
MAJORS=("${@:-}")
[ -z "${MAJORS[*]}" ] && MAJORS=(18 20 22 24 26)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO/bin/probe-runtime.js"
[ -f "$PROBE" ] || { echo "cannot find $PROBE" >&2; exit 1; }

case "$(uname -m)" in
  x86_64)  ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  armv7l)  ARCH=armv7l ;;
  *)       echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$WORKDIR" || exit 1
cd "$WORKDIR" || exit 1

echo "workdir: $WORKDIR"
echo "arch:    linux-$ARCH"
echo

for M in "${MAJORS[@]}"; do
  DIRURL="https://nodejs.org/dist/latest-v${M}.x"
  FILE=$(curl -fsSL "$DIRURL/" 2>/dev/null | grep -o "node-v[0-9.]*-linux-${ARCH}\.tar\.xz" | head -1)

  if [ -z "$FILE" ]; then
    echo "=== v$M: no linux-$ARCH build published ==="; echo; continue
  fi

  DIR="${FILE%.tar.xz}"
  if [ ! -x "$DIR/bin/node" ]; then
    echo "--- fetching $FILE"
    curl -fsSL -o "$FILE" "$DIRURL/$FILE" || { echo "=== v$M: download failed ==="; echo; continue; }
    tar xf "$FILE" || { echo "=== v$M: extract failed ==="; echo; continue; }
  fi

  echo "=== v$M: $DIR ==="
  # The probe spawns children itself, so run it under a node known to work --
  # but if none is known yet, the candidate has to drive its own probe.
  "$DIR/bin/node" "$PROBE" --node "$DIR/bin/node"
  RC=$?
  if [ $RC -ne 0 ] && [ $RC -ne 1 ]; then
    echo "  (probe driver itself exited $RC -- the candidate node could not even run the probe)"
    # Retry driving from whatever node is on PATH, if there is one.
    if command -v node >/dev/null 2>&1; then
      echo "  retrying, driven by $(command -v node):"
      node "$PROBE" --node "$DIR/bin/node"
    fi
  fi
  "$DIR/bin/node" "$PROBE" --node "$DIR/bin/node" --json > "$WORKDIR/report-v$M.json" 2>/dev/null
  echo
done

echo "JSON reports: $WORKDIR/report-v*.json"
