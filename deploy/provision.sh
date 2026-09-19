#!/usr/bin/env bash
#
# Brings a bare Ubuntu instance to a working stack. Idempotent: safe to re-run
# after a failure or a config change.
#
#   sudo ./deploy/provision.sh                    detects the public IP
#   sudo ./deploy/provision.sh --host 1.2.3.4     forces it
#   sudo ./deploy/provision.sh --skip-apt         when packages are already in
#
# It does NOT create accounts or install the app under test: both need an APK
# and the app's real selectors, which are per-deployment.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/redroid-organico}"
RUN_USER="${RUN_USER:-ubuntu}"
PUBLIC_HOST=""
SKIP_APT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --skip-apt) SKIP_APT=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

step() { echo; echo "==> $*"; }
warn() { echo "    warning: $*" >&2; }
die()  { echo "error: $*" >&2; exit 1; }

# `set -e` aborts without saying anything, which on a provisioning script is the
# worst possible silence: the log simply stops after whatever step was running,
# and finding out which command failed means re-running it by hand. This says so.
trap 'status=$?; echo; echo "error: fallo en la linea $LINENO con exit $status" >&2; echo "       comando: $BASH_COMMAND" >&2' ERR
as_user() { sudo -u "$RUN_USER" -H bash -lc "cd '$REPO_DIR' && $*"; }

# --- packages ----------------------------------------------------------------

if [[ $SKIP_APT -eq 0 ]]; then
  step "Installing packages"
  apt-get update -qq
  # adb: the worker talks to devices. ffmpeg: the media pipeline validates
  # uploads with ffprobe and accepts them unvalidated without it.
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git adb ffmpeg jq

  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh
  fi

  if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi

  usermod -aG docker "$RUN_USER" || true
fi

# --- binderfs ----------------------------------------------------------------
#
# The single hardest requirement, and the one that fails most confusingly.
# Kernels from 5.x set CONFIG_ANDROID_BINDER_DEVICES="" and create no
# /dev/binder: the devices live in binderfs, which has to be mounted.

step "Setting up binderfs"
modprobe binder_linux 2>/dev/null || true

if ! grep -q '^nodev\s*binder$' /proc/filesystems 2>/dev/null && ! grep -q 'binder' /proc/filesystems; then
  die "This kernel has no binderfs. ReDroid cannot run here.
Check with: grep -iE 'BINDER|ASHMEM' /boot/config-\$(uname -r)
A generic kernel (linux-generic) usually has it where a cloud kernel does not."
fi

mkdir -p /dev/binderfs
mountpoint -q /dev/binderfs || mount -t binder binder /dev/binderfs
[[ -e /dev/binderfs/binder-control ]] || die "binderfs mounted but has no binder-control"

grep -q '/dev/binderfs' /etc/fstab || echo 'binder /dev/binderfs binder nofail 0 0' >> /etc/fstab
echo binder_linux > /etc/modules-load.d/redroid.conf

# ashmem is gone from modern kernels; ReDroid 12+ falls back to memfd, which the
# provider requests. Only worth reporting.
grep -qi ASHMEM "/boot/config-$(uname -r)" 2>/dev/null \
  || echo "    (no ashmem in this kernel — ReDroid 12+ with use_memfd, which is the default)"

# --- repo --------------------------------------------------------------------

step "Installing the application"
[[ -d "$REPO_DIR/.git" ]] || die "$REPO_DIR is not a checkout. Clone the repo there first."
chown -R "$RUN_USER:$RUN_USER" "$REPO_DIR"
as_user "npm ci"

# --- configuration -----------------------------------------------------------

step "Writing .env"

if [[ -z "$PUBLIC_HOST" ]]; then
  # IMDSv2. Falls back to the private address, which is wrong for the viewer
  # but keeps the rest of the stack working.
  TOKEN="$(curl -s -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' --max-time 3 || true)"
  PUBLIC_HOST="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/public-ipv4 --max-time 3 || true)"
fi

[[ -n "$PUBLIC_HOST" ]] || { PUBLIC_HOST="$(hostname -I | awk '{print $1}')"; warn "using $PUBLIC_HOST for the viewer URL"; }

if [[ -f "$REPO_DIR/.env" ]]; then
  echo "    .env exists, leaving it alone"
else
  KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"

  cat > "$REPO_DIR/.env" <<ENV
DATABASE_URL="postgresql://redroid:redroid@localhost:5433/redroid?schema=public"
REDIS_URL="redis://localhost:6379"
CREDENTIALS_KEY="$KEY"

STORAGE_DRIVER="local"
STORAGE_LOCAL_DIR="./.storage"
# Deliberately not /tmp: that is a tmpfs on most cloud images, and staging video
# in RAM competes with the Android containers for the same memory.
MEDIA_STAGING_DIR="./.staging"

PUBLISHER_DRIVER="android"
WORKER_CONCURRENCY="2"
RETRY_ATTEMPTS="3"
RETRY_BACKOFF_MS="15000"
RATE_LIMIT_DEFER_MS="30000"

ANDROID_REAPER_INTERVAL_MS="300000"
ONBOARDING_TIMEOUT_MS="1200000"
DEVICE_VIEWER_URL_TEMPLATE="http://$PUBLIC_HOST:8000/#!action=stream&udid={serial}&player=broadway&ws=ws%3A%2F%2F$PUBLIC_HOST%3A8000%2F%3Faction%3Dproxy-adb%26remote%3Dtcp%253A8886%26udid%3D{serialDouble}"

ALLOW_REGISTRATION="false"
ENV

  chown "$RUN_USER:$RUN_USER" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  echo "    generated a fresh CREDENTIALS_KEY"
fi

# --- infrastructure ----------------------------------------------------------

step "Starting datastores and the device stack"
# Services named explicitly: a bare `up` would also start the compose copies of
# web and worker, which then compete with the systemd ones over one queue while
# resolving storage to a path inside their own container.
as_user "docker compose --profile android up -d --build postgres redis adb-server appium ws-scrcpy"

step "Applying migrations"
as_user "npx prisma migrate deploy"

# --- services ----------------------------------------------------------------

step "Installing systemd units"
sed "s#/home/ubuntu/redroid-organico#$REPO_DIR#g; s#User=ubuntu#User=$RUN_USER#" \
  "$REPO_DIR/deploy/redroid-web.service" > /etc/systemd/system/redroid-web.service
sed "s#/home/ubuntu/redroid-organico#$REPO_DIR#g; s#User=ubuntu#User=$RUN_USER#" \
  "$REPO_DIR/deploy/redroid-worker.service" > /etc/systemd/system/redroid-worker.service

systemctl daemon-reload
systemctl enable --now redroid-web redroid-worker
systemctl restart redroid-web redroid-worker

# --- verification ------------------------------------------------------------

step "Checking"
sleep 8
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "    ok    $1"; else echo "    FAIL  $1"; fail=1; fi }

check "binderfs"        "[ -e /dev/binderfs/binder-control ]"
check "adb server"      "adb -P 5037 devices"
check "appium"          "curl -sf localhost:4723/status"
check "ws-scrcpy"       "curl -sfI localhost:8000"
check "postgres"        "nc -z localhost 5433"
check "redis"           "nc -z localhost 6379"
check "worker"          "systemctl is-active --quiet redroid-worker"
check "dashboard"       "curl -sf localhost:3000 -o /dev/null"

cat <<EOF

Dashboard: http://$PUBLIC_HOST:3000
Viewer:    http://$PUBLIC_HOST:8000

Still to do by hand, because both are specific to your app:

  1. Seed a user:            npm run db:seed
  2. Copy the APK into $REPO_DIR
  3. Create an account:      npm run account:add -- --user <id> --name <name> \\
                               --driver android --credentials-file my-account.json

SECURITY: the dashboard runs in dev mode, where lib/auth/session.ts resolves a
user without a cookie — so it does NOT ask for a login. Restrict ports 3000 and
8000 to your own address in the security group before exposing this instance.
EOF

exit $fail
