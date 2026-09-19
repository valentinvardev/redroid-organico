#!/usr/bin/env bash
#
# Prepares a host to run emulators that are lent the operator's webcam.
# Idempotent: safe to re-run, before or after provision.sh. On a fresh instance
# run it first: the KVM check is the one that decides whether the machine is
# usable at all, and it takes a second instead of the minutes provision.sh
# spends installing Docker and Node before anything could fail.
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

# A fresh cloud instance runs unattended-upgrades at boot, and this script may
# also be started alongside provision.sh — either one holds the dpkg lock for
# minutes. Waiting is the correct answer; failing turns a busy machine into an
# unprovisionable one, and the error apt reports afterwards names the package
# it never got to look at rather than the lock.
APT="apt-get -o DPkg::Lock::Timeout=600"

step() { echo; echo "==> $*"; }
warn() { echo "    warning: $*" >&2; }
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

$APT update -qq

# The headers are what DKMS compiles against, and a fresh cloud image has none.
# Without them the package installs "successfully", builds nothing, and the
# modprobe below is the first thing to notice.
$APT install -y -qq "linux-headers-$(uname -r)" \
  || die "No headers for kernel $(uname -r), so DKMS cannot build anything.
  On an AWS kernel try: apt-get install linux-headers-aws"

# The V4L2 core (videodev). Its package name moves between kernel flavours and
# releases — on some AWS kernels the versioned one does not exist at all — so
# this is deliberately best effort rather than a hard requirement. Whether the
# core is actually present is decided by the modprobe below, which is the only
# check that means anything. Failing here on a package name would refuse to
# provision a host that works.
$APT install -y -qq "linux-modules-extra-$(uname -r)" 2>/dev/null \
  || $APT install -y -qq linux-modules-extra-aws 2>/dev/null \
  || warn "no linux-modules-extra for $(uname -r); continuing, the modprobe below is the real test"

# DKMS rebuilds the module on every kernel upgrade, or the camera disappears on
# the first reboot after an unattended-upgrades run.
$APT install -y -qq v4l2loopback-dkms v4l-utils \
  || die "Could not install v4l2loopback-dkms."

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

# v4l2loopback links against the V4L2 core, and on a kernel that keeps videodev
# in a package nobody installed, it fails with "Unknown symbol" rather than
# anything that names the cause.
modprobe videodev 2>/dev/null || true

modprobe v4l2loopback || die "v4l2loopback would not load for kernel $(uname -r).
  If dmesg shows 'Unknown symbol' the V4L2 core is missing: find the package
  that carries videodev for this kernel and install it.
  If it says the module is in use, a live session is still holding a camera.
  Check with: dmesg | tail -20"

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
