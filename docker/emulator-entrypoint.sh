#!/bin/sh
# Starts one emulator and makes its ADB reachable from outside the container.
#
# The indirection with socat is not optional. The emulator binds its console and
# ADB ports to 127.0.0.1 and refuses to be told otherwise, so a container that
# merely publishes 5555 answers nothing: `adb connect` gets a closed port and
# every explanation points at Android. Giving the emulator a high port pair and
# forwarding 5555 into it keeps the external contract identical to ReDroid's,
# which is what lets the provider, the gateway and ws-scrcpy stay unaware that
# this device is an emulator at all.
set -eu

CONSOLE_PORT=5584
ADB_PORT=5585

# A container that was killed rather than stopped leaves the AVD's lock behind,
# and the next boot refuses with "Running multiple emulators with the same AVD",
# suggesting -read-only. That flag is the wrong answer here: it stops writing
# changes back to the AVD, and the AVD is where the logged-in session lives —
# the entire reason this volume exists.
#
# Clearing the lock is safe because the invariant holds elsewhere: each account
# has its own volume, and the provider refuses to start a second container for
# an account that already has one. So a lock found here was never held by a
# live emulator.
find "${ANDROID_AVD_HOME:-/avd}" -maxdepth 3 -name '*.lock' -exec rm -rf {} + 2>/dev/null || true

# Headless, but with an X server present: the GPU path initialises against one
# even when nothing is displayed, and swiftshader is the only renderer that
# works on a server with no GPU.
export DISPLAY=:1
Xvfb :1 -screen 0 1080x1920x24 -nolisten tcp &

# Forwarded before the emulator starts, so a client connecting during boot gets
# a refused connection rather than a silent hang on an unbound port.
socat TCP-LISTEN:5555,fork,reuseaddr "TCP:127.0.0.1:${ADB_PORT}" &

# `exec` so the emulator is PID 1: it has to receive SIGTERM directly, or
# `docker stop` kills the shell and leaves a half-written userdata image behind
# — which is the account's session.
# No Vulkan, on a host with no GPU.
#
# The renderer here is SwiftShader, which implements GLES well and Vulkan
# partially. Android 14's UI toolkit prefers Vulkan, and the moment something
# heavy renders — the Play Store is the reliable trigger — SwiftShader logs
# hundreds of "UNSUPPORTED: curExtension->sType" and then segfaults, taking the
# whole emulator with it. The container exits 139 and the operator loses the
# phone mid-session, which reads as the device randomly dying.
#
# Two settings because they act at different levels: the feature flag keeps the
# guest from seeing a Vulkan device at all, and the HWUI property pins the UI
# renderer to the GL backend even where one is advertised.
exec emulator \
  -ports "${CONSOLE_PORT},${ADB_PORT}" \
  -no-window \
  -no-boot-anim \
  -no-audio \
  -gpu swiftshader_indirect \
  -feature -Vulkan \
  -prop debug.hwui.renderer=skiagl \
  -accel on \
  "$@"
