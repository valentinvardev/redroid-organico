#!/usr/bin/env bash
#
# Prints what was on the screen as a table of selectors, so a flow can be
# written from what the app actually exposes rather than from guesses.
#
#   ./scripts/dump-ui.sh                     live: first redroid-job-* device
#   ./scripts/dump-ui.sh <serial>            live: a specific device
#   ./scripts/dump-ui.sh --artifact          the newest saved failure dump
#   ./scripts/dump-ui.sh --artifact <path>   a specific saved dump
#   ... --all                                every node, not just targetable ones
#
# The artifact modes matter because a failed run has already been torn down:
# the device is gone, and the .xml the driver saved next to its screenshot is
# the only record of what the app was showing when the step failed.
set -euo pipefail

ARTIFACT=""
SERIAL=""
MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)
      if [[ -n "${2:-}" && "$2" != --* ]]; then
        ARTIFACT="$2"; shift 2
      else
        ARTIFACT="$(ls -t .storage/artifacts/*/*.xml 2>/dev/null | head -1 || true)"
        [[ -n "$ARTIFACT" ]] || { echo "No saved dumps under .storage/artifacts/." >&2; exit 1; }
        shift
      fi
      ;;
    --all) MODE="--all"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) SERIAL="$1"; shift ;;
  esac
done

if [[ -n "$ARTIFACT" ]]; then
  echo "artifact: $ARTIFACT" >&2
  XML="$(cat "$ARTIFACT")"
else
  if [[ -z "$SERIAL" ]]; then
    SERIAL="$(adb devices | awk '/redroid-job/ && /device$/ {print $1; exit}')"
  fi

  if [[ -z "$SERIAL" ]]; then
    echo "No redroid-job-* device attached. Start a run, pass a serial, or use --artifact." >&2
    adb devices >&2
    exit 1
  fi

  echo "device: $SERIAL" >&2
  XML="$(adb -s "$SERIAL" exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r')"
fi

[[ -n "$XML" ]] || { echo "Nothing to read." >&2; exit 1; }

MODE="$MODE" python3 - <<'PY' <<<"$XML"
import os, re, sys

xml = sys.stdin.read()
show_all = os.environ.get('MODE') == '--all'

rows = []
for node in re.findall(r'<node\b[^>]*>', xml):
    def attr(name):
        m = re.search(rf'{name}="([^"]*)"', node)
        return m.group(1) if m else ''

    rid, text, desc = attr('resource-id'), attr('text'), attr('content-desc')
    klass, clickable = attr('class').split('.')[-1], attr('clickable') == 'true'

    # A node with no id, no text and no description cannot be targeted, and a
    # node nobody can touch is rarely what a flow is waiting for.
    if not show_all and not (rid or text or desc):
        continue
    if not show_all and not clickable and not text and not rid:
        continue

    rows.append((rid, text, desc, klass, 'tap' if clickable else ''))

if not rows:
    print('Nothing targetable on screen.', file=sys.stderr)
    sys.exit(1)

header = ('resource-id', 'text', 'content-desc', 'class', '')
widths = [min(60, max(len(r[i]) for r in rows + [header])) for i in range(5)]

def line(cols):
    return '  '.join(c[:60].ljust(w) for c, w in zip(cols, widths))

print(line(header))
print('  '.join('-' * w for w in widths))
for row in rows:
    print(line(row))

print(f'\n{len(rows)} targetable nodes.', file=sys.stderr)
print('resource-id -> using "id"; content-desc -> using "accessibility id".', file=sys.stderr)
PY
