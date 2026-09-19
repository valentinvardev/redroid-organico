#!/usr/bin/env bash
#
# Builds a ReDroid image with Google Play Store and Play Services in it.
#
#   ./scripts/build-gapps-image.sh --tag redroid-organico/redroid:13-gapps
#
# ReDroid ships plain AOSP: no Play Store, no Play Services, and nothing in the
# account config can add them, because they live in the system image. This bakes
# MindTheGapps into one, using the community tool that already solves the hard
# part (ayasa520/redroid-script). The result goes in the account's
# `redroid.image` like any other tag.
#
# Two things to know before using it, because neither is reversible:
#
#  1. The device comes up UNCERTIFIED. Google's servers only trust build
#     fingerprints they have seen, and this one they have not. Play Store
#     refuses to sign in until the device's GSF Android ID is registered once at
#     https://www.google.com/android/uncertified — and registration is per
#     device, so it must be redone for every account's session volume.
#
#  2. An uncertified device with Google apps on it is a louder fingerprint than
#     no Google apps at all. It fails Play Integrity by construction. If the
#     account only needs the app under test installed, `apkPath` already does
#     that and this image is the wrong tool.
#
# The emulator provider does not need any of this: its system image is
# `google_apis_playstore`, which ships a certified Play Store. See
# Dockerfile.emulator.
set -euo pipefail

ANDROID_VERSION="13.0.0"
TAG=""
# Unpinned on purpose, and the one thing here that is not reproducible: upstream
# publishes no tags or releases, so there is nothing to pin to out of the box.
# The resolved commit is printed below — pass it back with --ref once a build
# has been verified, and this becomes reproducible.
REF="main"
WORK_DIR="${HOME}/.cache/redroid-gapps"
BINDERFS="/dev/binderfs"
BOOT_TIMEOUT=300
ADB_PORT=5039
VERIFY=1

usage() {
  cat <<'USAGE'
Usage: build-gapps-image.sh --tag <image:tag> [options]

  --tag <image:tag>   Name for the resulting image (required). Use your own
                      namespace: the upstream tool tags into `redroid/redroid`,
                      where a later `docker pull` can shadow your build.
  --android <ver>     Android version (default: 13.0.0). Must be one the tool
                      supports: 14.0.0, 13.0.0, 12.0.0, 12.0.0_64only, 11.0.0.
  --ref <commit>      Commit of ayasa520/redroid-script to build with.
  --work-dir <path>   Where the tool is cloned and GApps cached (~4 GB).
  --binderfs <path>   Host binderfs mount, for the verification boot.
  --boot-timeout <s>  Seconds to wait for Android (default: 300).
  --skip-verify       Do not boot the result to check Play Store is in it.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --android) ANDROID_VERSION="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --binderfs) BINDERFS="$2"; shift 2 ;;
    --boot-timeout) BOOT_TIMEOUT="$2"; shift 2 ;;
    --skip-verify) VERIFY=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[[ -n "$TAG" ]] || { usage; die "--tag is required"; }
command -v git >/dev/null || die "git is not on PATH"
command -v python3 >/dev/null || die "python3 is not on PATH"
command -v docker >/dev/null || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Add yourself to the docker group, or run this with sudo."

if (( VERIFY )); then
  command -v adb >/dev/null || die "adb is not on PATH (apt-get install -y adb), or pass --skip-verify"
fi

# --- the tool ----------------------------------------------------------------

step "Fetching the build tool"
mkdir -p "$WORK_DIR"
REPO="$WORK_DIR/redroid-script"

if [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" fetch --quiet origin
else
  git clone --quiet https://github.com/ayasa520/redroid-script.git "$REPO"
fi

git -C "$REPO" checkout --quiet "$REF"
git -C "$REPO" pull --quiet --ff-only 2>/dev/null || true
RESOLVED="$(git -C "$REPO" rev-parse HEAD)"
echo "    at $RESOLVED"
echo "    (pass --ref $RESOLVED to rebuild exactly this)"

# A venv rather than a bare pip install: Ubuntu 24.04 and newer refuse to touch
# the system site-packages (PEP 668), and --break-system-packages is a worse
# answer than a directory.
step "Preparing the Python environment"
[[ -d "$REPO/.venv" ]] || python3 -m venv "$REPO/.venv"
"$REPO/.venv/bin/pip" install --quiet --upgrade requests tqdm

# --- the build ---------------------------------------------------------------

# MindTheGapps, not OpenGApps, and this is the part that silently goes wrong:
# the tool hard-gates `-g` to Android 11, and on any other version it prints a
# yellow warning, installs nothing, and still exits 0. A GApps-free image would
# come out the other side looking like a success. `-mtg` is the one that works
# on 13, and it cannot be bundled with single-letter flags.
step "Building (this downloads ~400 MB of GApps and can take a while)"
( cd "$REPO" && "$REPO/.venv/bin/python" redroid.py -a "$ANDROID_VERSION" -mtg )

# The tool names its output itself, joining the feature list with underscores.
# Checked rather than trusted, because of the silent no-op above: an exit code
# of 0 here does not mean the image exists.
BUILT="redroid/redroid:${ANDROID_VERSION}_mindthegapps"

docker image inspect "$BUILT" >/dev/null 2>&1 || die \
"the tool finished but produced no $BUILT.

That is what a silently skipped GApps install looks like. Check the build output
above for a yellow warning, and confirm $ANDROID_VERSION is a version
MindTheGapps publishes."

# Re-tagged out of the upstream namespace immediately: leaving it as
# redroid/redroid:... means a later `docker pull` of an official image can
# shadow a local build nobody can rebuild identically.
docker tag "$BUILT" "$TAG"
echo "    tagged $TAG"

# --- verification ------------------------------------------------------------

if (( ! VERIFY )); then
  echo
  echo "Built $TAG (not verified)."
  exit 0
fi

if [[ -n "$BINDERFS" && ! -e "$BINDERFS/binder-control" ]]; then
  die "binderfs is not mounted at $BINDERFS, so the image cannot be booted to verify it.
Mount it (sudo modprobe binder_linux && sudo mount -t binder binder /dev/binderfs),
or pass --skip-verify."
fi

CONTAINER="gapps-verify-$$"
SERIAL=""

cleanup() {
  local code=$?
  [[ -n "$SERIAL" ]] && adb -P "$ADB_PORT" disconnect "$SERIAL" >/dev/null 2>&1 || true
  adb -P "$ADB_PORT" kill-server >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit $code
}
trap cleanup EXIT

step "Booting $TAG to check Play Store is really in it"
mounts=()
[[ -n "$BINDERFS" ]] && mounts+=(-v "$BINDERFS:/dev/binderfs")

docker run -d --privileged --name "$CONTAINER" \
  "${mounts[@]}" \
  -p 127.0.0.1::5555 \
  "$TAG" \
  androidboot.redroid_width=1080 \
  androidboot.redroid_height=1920 \
  androidboot.redroid_dpi=480 \
  androidboot.redroid_gpu_mode=guest \
  androidboot.use_memfd=1 >/dev/null

HOST_PORT="$(docker port "$CONTAINER" 5555/tcp | head -1 | sed 's/.*://')"
[[ -n "$HOST_PORT" ]] || die "container did not publish its ADB port"
SERIAL="127.0.0.1:$HOST_PORT"

adb -P "$ADB_PORT" start-server >/dev/null 2>&1
adb -P "$ADB_PORT" connect "$SERIAL" >/dev/null

# GApps make the first boot considerably slower than a bare ReDroid: Play
# Services runs its own first-run setup after boot_completed flips.
deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
while :; do
  booted="$(adb -P "$ADB_PORT" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  anim="$(adb -P "$ADB_PORT" -s "$SERIAL" shell getprop init.svc.bootanim 2>/dev/null | tr -d '\r')"

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

packages="$(adb -P "$ADB_PORT" -s "$SERIAL" shell pm list packages 2>/dev/null | tr -d '\r')"

for package in com.android.vending com.google.android.gms; do
  grep -q "package:$package" <<<"$packages" \
    || die "$package is not installed in $TAG — the GApps layer did not take"
  echo "    ok  $package"
done

cat <<EOF

Built and verified: $TAG

Put it in the account's credentials:

    "redroid": { "image": "$TAG", ... }

First boot of each account still needs one manual step. The device is not
certified, so Play Store will refuse to sign in until you register it:

  1. Read the device's GSF Android ID from the phone during onboarding.
  2. Register it at https://www.google.com/android/uncertified
  3. Force stop Play Services and Play Store, clear their storage, reboot.

It is per device, so every account's session volume needs it once. Sign-in
usually works within 15 minutes of registering.
EOF
