#!/usr/bin/env bash
#
# Prepares a host to run emulators that are lent the operator's webcam.
# Idempotent: safe to re-run. Run after provision.sh, on the host that will run
# emulator accounts.
#
#   sudo ./deploy/provision-camera.sh                 four camera slots, 10-13
#   sudo ./deploy/provision-camera.sh --slots 8       eight slots, 10-17
#
# Separate from provision.sh on purpose. The emulator needs KVM, and on EC2 KVM
# means an Intel instance with nested virtualization enabled — so this is very
# likely a different machine from the Graviton one ReDroid runs on, and
# provisioning it should not be a side effect of provisioning that one.
set -euo pipefail

SLOTS=4
FIRST_INDEX=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slots) SLOTS="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

step() { echo; echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- KVM ---------------------------------------------------------------------
# Checked first because nothing below is worth doing without it. The emulator
# falls back to TCG when /dev/kvm is missing, and a boot that should take two
# minutes takes forty — long enough that every timeout in the provider fires
# and the failure reads as Android being broken.
step "Checking for hardware virtualization"

if [[ ! -e /dev/kvm ]]; then
  die "/dev/kvm does not exist. On EC2 this needs a bare metal instance, or a virtual
  one launched with --cpu-options \"NestedVirtualization=enabled\" — supported on the
  Intel families only (M7i/M8i, C7i/C8i, R7i/R8i, I7i, X8i). Graviton instances
  cannot run the emulator unless they are .metal."
fi

[[ "$(uname -m)" == "x86_64" ]] || echo "    warning: $(uname -m) host. Dockerfile.emulator builds an x86_64 image."

# The docker group reads /dev/kvm through the container runtime, but a host
# where it is root-only 0600 fails in a way that looks like a missing device.
chmod 666 /dev/kvm
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' > /etc/udev/rules.d/65-kvm.rules

# --- v4l2loopback ------------------------------------------------------------
# One loopback device per camera slot. The indices start at 10 so they can
# never collide with a real webcam the kernel numbers from 0, and they must
# match CAMERA_DEVICE_POOL exactly.
step "Setting up v4l2loopback (${SLOTS} slots from /dev/video${FIRST_INDEX})"

# linux-modules-extra carries the V4L2 core on the AWS kernel, which ships
# without it; DKMS rebuilds the module on every kernel upgrade, or the camera
# disappears on the first reboot after an unattended-upgrades run.
apt-get update -qq
apt-get install -y -qq "linux-modules-extra-$(uname -r)" v4l2loopback-dkms v4l-utils \
  || die "Could not install v4l2loopback. On a custom kernel, install its headers first."

INDICES=$(seq -s, "$FIRST_INDEX" "$((FIRST_INDEX + SLOTS - 1))")

# exclusive_caps=1 is not optional. Without it a loopback device reports both
# OUTPUT and CAPTURE, and the emulator — like Chromium — skips any device that
# does not look like a plain capture device. It exists, ffplay can read it,
# and the emulator's -webcam-list never mentions it.
cat > /etc/modprobe.d/redroid-camera.conf <<EOF
options v4l2loopback devices=${SLOTS} video_nr=${INDICES} exclusive_caps=1 card_label=redroid-camera
EOF

echo v4l2loopback > /etc/modules-load.d/redroid-camera.conf

# Reloaded rather than merely loaded, so a change in --slots takes effect.
# Refused while a device is open, which is the correct answer: a live session
# is using one.
modprobe -r v4l2loopback 2>/dev/null || true
modprobe v4l2loopback || die "v4l2loopback would not load. Is a session still holding a camera open?"

# --- Verify ------------------------------------------------------------------
step "Verifying"

fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "    ok    $1"; else echo "    FAIL  $1"; fail=1; fi }

check "kvm"               "[ -r /dev/kvm ] && [ -w /dev/kvm ]"
for index in $(seq "$FIRST_INDEX" "$((FIRST_INDEX + SLOTS - 1))"); do
  check "/dev/video${index}" "[ -e /dev/video${index} ]"
done

echo
if [[ $fail -eq 0 ]]; then
  echo "Camera host ready. In .env:"
  echo "    CAMERA_DEVICE_POOL=\"${INDICES}\""
else
  echo "Some checks failed; see above."
  exit 1
fi
