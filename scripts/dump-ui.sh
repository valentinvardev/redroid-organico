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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="$HERE/parse-ui-dump.py"

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
  # Piped rather than fed through a here-string alongside the parser: two stdin
  # redirections on one command and the last one wins, which fed the XML to
  # python as its own source code.
  cat "$ARTIFACT" | python3 "$PARSER" $MODE
  exit
fi

if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk '/redroid-job/ && /device$/ {print $1; exit}')"
fi

if [[ -z "$SERIAL" ]]; then
  echo "No redroid-job-* device attached. Start a run, pass a serial, or use --artifact." >&2
  adb devices >&2
  exit 1
fi

echo "device: $SERIAL" >&2
adb -s "$SERIAL" exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r' | python3 "$PARSER" $MODE
