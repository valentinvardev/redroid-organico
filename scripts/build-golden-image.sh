#!/usr/bin/env bash
#
# DOES NOT WORK FOR USER APPS. Kept only for the system-app case.
#
# Verified on Ubuntu 26.04 / Graviton: a user app installs and verifies inside
# the build container, and the committed image comes out without it. ReDroid
# mounts /data at runtime and `docker commit` captures only the container's
# writable layer, so everything under /data — which is where user apps live —
# is silently dropped. The build reports success because every step it performs
# genuinely succeeded.
#
# Install at runtime instead: set `apkPath` in the account credentials and the
# provider installs the APK when the device does not have the package. On a
# persistent session volume that cost is paid once per account.
#
# This script remains useful only if the app is turned into a system app under
# /system or /product, which does live in the image layers.
#
# ---------------------------------------------------------------------------
# Builds the golden image: ReDroid with the app under test already installed.
#
# Runs a throwaway container on its own adb server and its own published port,
# so it does not collide with the shared adb server the stack uses and can be
# run before the stack is up at all.
#
#   ./scripts/build-golden-image.sh --apk ./sportreels.apk --tag sportreels/redroid:13-golden
#
set -euo pipefail

BASE_IMAGE="redroid/redroid:13.0.0-latest"
BINDERFS="/dev/binderfs"
# A dedicated adb server, so this never fights the containerised one on 5037.
ADB_PORT=5038
BOOT_TIMEOUT=180
APK=""
TAG=""
PACKAGE=""
TOOLS=()

usage() {
  cat <<'USAGE'
Usage: build-golden-image.sh --apk <file.apk> --tag <image:tag> [options]

  --apk <file>        APK to install into the image (required)
  --tag <image:tag>   Name for the resulting image (required)
  --package <name>    Package name to verify after install.
                      Defaults to whatever aapt/the APK reports, and falls back
                      to skipping the check if it cannot be determined.
  --base <image>      Base ReDroid image (default: redroid/redroid:13.0.0-latest)
  --binderfs <path>   Host binderfs mount (default: /dev/binderfs, "" to skip)
  --boot-timeout <s>  Seconds to wait for Android to boot (default: 180)
  --tool <file>       Static binary to place in /system/bin (repeatable).
                      Use it for a statically linked arm64 curl: the egress
                      check runs on the device, and AOSP ships no curl. It has
                      to go in /system rather than /data, because /data is a
                      runtime mount that docker commit never captures.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --base) BASE_IMAGE="$2"; shift 2 ;;
    --binderfs) BINDERFS="$2"; shift 2 ;;
    --boot-timeout) BOOT_TIMEOUT="$2"; shift 2 ;;
    --tool) TOOLS+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[[ -n "$APK" ]] || { usage; die "--apk is required"; }
[[ -n "$TAG" ]] || { usage; die "--tag is required"; }
[[ -f "$APK" ]] || die "APK not found: $APK"
command -v docker >/dev/null || die "docker is not on PATH"
command -v adb >/dev/null || die "adb is not on PATH (sudo apt-get install -y adb)"

# Fail here rather than after a five-minute boot that was never going to work.
if [[ -n "$BINDERFS" ]]; then
  [[ -e "$BINDERFS/binder-control" ]] || die \
"binderfs is not mounted at $BINDERFS.

  sudo modprobe binder_linux
  sudo mkdir -p /dev/binderfs
  sudo mount -t binder binder /dev/binderfs

Pass --binderfs '' if this host exposes /dev/binder directly."
fi

CONTAINER="golden-build-$$"
SERIAL=""

cleanup() {
  local code=$?
  step "Cleaning up"
  [[ -n "$SERIAL" ]] && adb -P "$ADB_PORT" disconnect "$SERIAL" >/dev/null 2>&1 || true
  adb -P "$ADB_PORT" kill-server >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit $code
}
trap cleanup EXIT

step "Starting $BASE_IMAGE"
mounts=()
[[ -n "$BINDERFS" ]] && mounts+=(-v "$BINDERFS:/dev/binderfs")

docker run -d --privileged --name "$CONTAINER" \
  "${mounts[@]}" \
  -p 127.0.0.1::5555 \
  "$BASE_IMAGE" \
  androidboot.redroid_width=1080 \
  androidboot.redroid_height=1920 \
  androidboot.redroid_dpi=480 \
  androidboot.redroid_gpu_mode=guest \
  androidboot.use_memfd=1 >/dev/null

HOST_PORT="$(docker port "$CONTAINER" 5555/tcp | head -1 | sed 's/.*://')"
[[ -n "$HOST_PORT" ]] || die "container did not publish its ADB port"
SERIAL="127.0.0.1:$HOST_PORT"
echo "    container $CONTAINER on $SERIAL"

step "Waiting for Android to finish booting (up to ${BOOT_TIMEOUT}s)"
adb -P "$ADB_PORT" start-server >/dev/null 2>&1
adb -P "$ADB_PORT" connect "$SERIAL" >/dev/null

deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
while :; do
  booted="$(adb -P "$ADB_PORT" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  anim="$(adb -P "$ADB_PORT" -s "$SERIAL" shell getprop init.svc.bootanim 2>/dev/null | tr -d '\r')"

  # The same two gates AdbDevice.waitUntilReady() checks, for the same reason:
  # boot_completed flips while the package manager is still settling.
  if [[ "$booted" == "1" && "$anim" == "stopped" ]]; then
    echo "    booted"
    break
  fi

  if (( $(date +%s) >= deadline )); then
    echo "--- last container logs ---" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    die "Android did not boot within ${BOOT_TIMEOUT}s"
  fi

  adb -P "$ADB_PORT" connect "$SERIAL" >/dev/null 2>&1 || true
  sleep 3
done

step "Installing $(basename "$APK")"
adb -P "$ADB_PORT" -s "$SERIAL" install -r "$APK"

# /system, not /data: ReDroid mounts /data at runtime and `docker commit` only
# captures the writable layer, which is the whole reason the APK above cannot be
# baked in either. /system does live in the image layers.
if (( ${#TOOLS[@]} > 0 )); then
  step "Adding ${#TOOLS[@]} tool(s) to /system/bin"
  adb -P "$ADB_PORT" -s "$SERIAL" root >/dev/null 2>&1 || true
  sleep 2
  adb -P "$ADB_PORT" connect "$SERIAL" >/dev/null 2>&1 || true

  adb -P "$ADB_PORT" -s "$SERIAL" remount >/dev/null 2>&1 \
    || adb -P "$ADB_PORT" -s "$SERIAL" shell mount -o rw,remount /system >/dev/null 2>&1 \
    || die "could not make /system writable — this image may enforce verity, in which case set
proxyGateway.egressCheck.url to an http:// endpoint and let the check fall back to busybox wget."

  for tool in "${TOOLS[@]}"; do
    [[ -f "$tool" ]] || die "tool not found: $tool"
    name="$(basename "$tool")"

    adb -P "$ADB_PORT" -s "$SERIAL" push "$tool" "/system/bin/$name" >/dev/null
    adb -P "$ADB_PORT" -s "$SERIAL" shell chmod 0755 "/system/bin/$name"

    # A dynamically linked binary pushes fine and then fails with "not
    # executable" at the moment a job needs it, which is the worst time to find
    # out. Prove it runs now.
    adb -P "$ADB_PORT" -s "$SERIAL" shell "$name" --version >/dev/null 2>&1 \
      || die "$name does not run on the device — it has to be statically linked for arm64"

    echo "    $name ok"
  done
fi

if [[ -z "$PACKAGE" ]] && command -v aapt >/dev/null; then
  PACKAGE="$(aapt dump badging "$APK" 2>/dev/null | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
fi

if [[ -n "$PACKAGE" ]]; then
  step "Verifying $PACKAGE is installed"
  adb -P "$ADB_PORT" -s "$SERIAL" shell pm path "$PACKAGE" | grep -q '^package:' \
    || die "$PACKAGE is not present after install"

  # Launch once so the app creates its data directories. An image whose first
  # ever launch happens during a real job spends that job's budget on
  # first-run initialisation.
  step "Warming up $PACKAGE"
  adb -P "$ADB_PORT" -s "$SERIAL" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 8
  adb -P "$ADB_PORT" -s "$SERIAL" shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
else
  echo "    (no package name available; skipping verification)" >&2
fi

step "Flushing and stopping the container"
# Committing a running Android can capture a half-written database.
adb -P "$ADB_PORT" -s "$SERIAL" shell sync || true
adb -P "$ADB_PORT" disconnect "$SERIAL" >/dev/null 2>&1 || true
SERIAL=""
docker stop "$CONTAINER" >/dev/null

step "Committing $TAG"
docker commit "$CONTAINER" "$TAG" >/dev/null
docker image inspect "$TAG" --format '    {{.Id}}  {{.Size}} bytes  {{.Architecture}}'

cat <<EOF

Done. Use it in the account's redroid block:

  "image": "$TAG"

Note: each account's session volume is populated from this image's /data the
first time it is used, and never again. Rebuilding the image with a newer APK
does NOT reach accounts that already have a volume — remove theirs to pick it
up, which also drops the logged-in session and means re-onboarding:

  docker volume rm redroid-session-<accountId>
EOF
