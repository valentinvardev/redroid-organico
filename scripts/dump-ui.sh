#!/usr/bin/env bash
#
# Prints what is on the device's screen as a table of selectors, so a flow can
# be written from what the app actually exposes rather than from guesses.
#
#   ./scripts/dump-ui.sh                 # first redroid-job-* device found
#   ./scripts/dump-ui.sh <serial>
#   ./scripts/dump-ui.sh <serial> --all  # every node, not just the useful ones
#
# Raw `uiautomator dump` output is one enormous line of XML; this pulls out the
# fields a UI flow can actually target.
set -euo pipefail

SERIAL="${1:-}"
MODE="${2:-}"

if [[ -z "$SERIAL" || "$SERIAL" == --* ]]; then
  MODE="${SERIAL:-}"
  SERIAL="$(adb devices | awk '/redroid-job/ && /device$/ {print $1; exit}')"
fi

if [[ -z "$SERIAL" ]]; then
  echo "No redroid-job-* device attached. Start a link from the dashboard, or pass a serial." >&2
  adb devices >&2
  exit 1
fi

echo "device: $SERIAL" >&2

XML="$(adb -s "$SERIAL" exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r')"

if [[ -z "$XML" ]]; then
  echo "uiautomator returned nothing. Is the screen on and the app in the foreground?" >&2
  exit 1
fi

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

widths = [max(len(r[i]) for r in rows + [('resource-id', 'text', 'content-desc', 'class', '')]) for i in range(5)]
header = ('resource-id', 'text', 'content-desc', 'class', '')

def line(cols):
    return '  '.join(c[:60].ljust(min(w, 60)) for c, w in zip(cols, widths))

print(line(header))
print('  '.join('-' * min(w, 60) for w in widths))
for row in rows:
    print(line(row))

print(f'\n{len(rows)} targetable nodes.', file=sys.stderr)
print('resource-id -> using "id"; content-desc -> using "accessibility id".', file=sys.stderr)
PY
