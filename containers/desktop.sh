#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.config/dyad" "$HOME/dyad-apps"
export XDG_RUNTIME_DIR="/tmp/dyad-runtime-$(id -u)"
export PATH="/opt/dyad/containers/bin:$PATH"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${DYAD_SCREEN_SIZE:-1440x900x24}" -nolisten tcp &
pids+=("$!")
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

fluxbox &
pids+=("$!")
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw &
pids+=("$!")
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 &
pids+=("$!")
# The OAuth handler listens on container loopback. This relay makes it
# reachable through Podman's host-loopback-only published callback port.
node /opt/dyad/containers/oauth-callback-proxy.cjs &
pids+=("$!")
# Rootless Podman supplies the outer isolation. The launcher provides a
# filtered proxy for org.freedesktop.secrets so Electron's libsecret backend
# can use the host GNOME keyring without exposing the full desktop bus.
# Chromium's nested sandbox is unavailable on hosts that prohibit
# unprivileged user namespaces.
/opt/dyad/node_modules/electron/dist/electron \
  /opt/dyad/containers/keyring-preflight.cjs --no-sandbox \
  --password-store=gnome-libsecret
/opt/dyad/desktop --no-sandbox --disable-gpu \
  --password-store=gnome-libsecret "$@" &
pids+=("$!")
wait -n "${pids[@]}"
