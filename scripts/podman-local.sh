#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image="${DYAD_CONTAINER_IMAGE:-localhost/dyad:local}"
name="${DYAD_CONTAINER_NAME:-dyad-local}"
volume="${DYAD_CONTAINER_VOLUME:-dyad-local-home}"
port="${DYAD_DESKTOP_PORT:-6080}"
app_artifacts_dir="${DYAD_APP_ARTIFACTS_DIR:-$HOME/src.d/dyad-apps}"
runtime_dir="${XDG_RUNTIME_DIR:-}"
proxy_socket="${runtime_dir:+$runtime_dir/dyad-local-secrets-bus}"
proxy_unit="${name}-secrets-proxy.service"
open_uri_socket="${runtime_dir:+$runtime_dir/dyad-local-open-uri.sock}"
open_uri_unit="${name}-open-uri.service"
proxy_recreated=0
gemini_env_args=()
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  gemini_env_args+=(--env GEMINI_API_KEY)
fi

stop_keyring_proxy() {
  systemctl --user stop "$proxy_unit" >/dev/null 2>&1 || true
  if [[ -n "$proxy_socket" ]]; then
    unlink "$proxy_socket" 2>/dev/null || true
  fi
}

stop_open_uri_bridge() {
  systemctl --user stop "$open_uri_unit" >/dev/null 2>&1 || true
  if [[ -n "$open_uri_socket" ]]; then
    unlink "$open_uri_socket" 2>/dev/null || true
  fi
}

ensure_open_uri_bridge() {
  if [[ -z "$runtime_dir" ]]; then
    printf 'A logged-in desktop session is required to open provider sign-in in the host browser.\n' >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1 || ! command -v xdg-open >/dev/null 2>&1; then
    printf 'Node.js and xdg-open are required for the host-browser bridge.\n' >&2
    return 1
  fi
  if [[ -S "$open_uri_socket" ]] && systemctl --user is-active --quiet "$open_uri_unit"; then
    return 0
  fi

  stop_open_uri_bridge
  systemd-run --user --unit="$open_uri_unit" --collect --quiet \
    "$(command -v node)" "$repo_root/scripts/podman-open-uri.mjs" "$open_uri_socket"
  for attempt in {1..50}; do
    if [[ -S "$open_uri_socket" ]]; then break; fi
    if ! systemctl --user is-active --quiet "$open_uri_unit"; then
      journalctl --user-unit "$open_uri_unit" --no-pager -n 20 >&2 || true
      return 1
    fi
    sleep 0.1
  done
  if [[ ! -S "$open_uri_socket" ]]; then
    printf 'Timed out starting the host-browser bridge.\n' >&2
    journalctl --user-unit "$open_uri_unit" --no-pager -n 20 >&2 || true
    stop_open_uri_bridge
    return 1
  fi
}

ensure_keyring_proxy() {
  if [[ -z "$runtime_dir" || -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    printf 'A GNOME keyring session bus is required. Start Dyad from your logged-in desktop session.\n' >&2
    return 1
  fi
  if ! command -v xdg-dbus-proxy >/dev/null 2>&1; then
    printf 'xdg-dbus-proxy is required to expose only GNOME Secret Service to the container.\n' >&2
    return 1
  fi
  if ! command -v systemd-run >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
    printf 'A systemd user session is required to keep the filtered keyring proxy alive.\n' >&2
    return 1
  fi
  if ! command -v busctl >/dev/null 2>&1 || \
    ! busctl --address="$DBUS_SESSION_BUS_ADDRESS" --no-pager \
      status org.freedesktop.secrets >/dev/null 2>&1; then
    printf 'org.freedesktop.secrets is unavailable on the host session bus; refusing to start Dyad without encrypted secret storage.\n' >&2
    return 1
  fi

  if [[ -S "$proxy_socket" ]] && systemctl --user is-active --quiet "$proxy_unit"; then
    return 0
  fi

  stop_keyring_proxy
  systemd-run --user --unit="$proxy_unit" --collect --quiet \
    /usr/bin/xdg-dbus-proxy "$DBUS_SESSION_BUS_ADDRESS" "$proxy_socket" \
    --filter --talk=org.freedesktop.secrets
  proxy_recreated=1
  for attempt in {1..50}; do
    if [[ -S "$proxy_socket" ]]; then break; fi
    if ! systemctl --user is-active --quiet "$proxy_unit"; then
      journalctl --user-unit "$proxy_unit" --no-pager -n 20 >&2 || true
      return 1
    fi
    sleep 0.1
  done
  if [[ ! -S "$proxy_socket" ]]; then
    printf 'Timed out starting the GNOME Secret Service proxy.\n' >&2
    journalctl --user-unit "$proxy_unit" --no-pager -n 20 >&2 || true
    stop_keyring_proxy
    return 1
  fi
  # The container uses a different UID mapping. The filtered proxy socket is
  # the only world-writable endpoint; the host session bus stays inaccessible.
  chmod 666 "$proxy_socket"
}

case "${1:-help}" in
  build)
    podman build -f "$repo_root/containers/Containerfile" -t "$image" "$repo_root"
    ;;
  up)
    ensure_keyring_proxy
    ensure_open_uri_bridge
    mkdir -p "$app_artifacts_dir"
    # Rootless Podman maps the container's node UID to a subordinate host UID.
    # Keep that mapping for Dyad's home volume, while ACLs let the host editor
    # read and write the same project files.
    podman unshare chown 1000:1000 "$app_artifacts_dir"
    podman unshare setfacl -m u:0:rwx,u:1000:rwx \
      -m d:u:0:rwx,d:u:1000:rwx "$app_artifacts_dir"
    if podman container exists "$name"; then
      mount_destinations="$(podman inspect "$name" --format '{{range .Mounts}}{{.Destination}} {{end}}')"
      if [[ " $mount_destinations " != *" /home/node/dyad-apps "* ]]; then
        # Preserve any projects in the old container before the bind mount
        # hides its home-directory copy.
        old_apps="$(podman cp "$name":/home/node/dyad-apps/. - | tar -tf -)"
        if [[ -n "$old_apps" ]]; then
          if find "$app_artifacts_dir" -mindepth 1 -print -quit | grep -q .; then
            printf 'Both the container and host app directories contain files; merge them before starting Dyad.\n' >&2
            return 1
          fi
          podman cp "$name":/home/node/dyad-apps/. "$app_artifacts_dir"
        fi
      fi
      if [[ " $mount_destinations " != *" /run/dyad-open-uri.sock "* || \
        " $mount_destinations " != *" /opt/dyad/containers/bin "* || \
        " $mount_destinations " != *" /opt/dyad/containers/oauth-callback-proxy.cjs "* || \
        "$(podman port "$name" 1455/tcp 2>/dev/null || true)" != "127.0.0.1:1455" ]]; then
        podman rm -f "$name"
      fi
    fi
    if podman container exists "$name"; then
      container_has_gemini_key=0
      if podman inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' | \
        grep -q '^GEMINI_API_KEY='; then
        container_has_gemini_key=1
      fi
      host_has_gemini_key=0
      if [[ -n "${GEMINI_API_KEY:-}" ]]; then
        host_has_gemini_key=1
      fi
      gemini_env_missing=0
      if [[ "$host_has_gemini_key" == 1 && "$container_has_gemini_key" == 0 ]]; then
        gemini_env_missing=1
      fi
      if [[ "$proxy_recreated" == 1 || \
        " $mount_destinations " != *" /run/dyad-secrets-bus "* || \
        " $mount_destinations " != *" /opt/dyad/containers/keyring-preflight.cjs "* || \
        "$gemini_env_missing" == 1 ]]; then
        # Replace only the container configuration; user data lives in the
        # named volume and is preserved.
        podman rm -f "$name"
      elif [[ " $mount_destinations " != *" /home/node/dyad-apps "* ]]; then
        podman rm -f "$name"
      fi
    fi
    if podman container exists "$name"; then
      podman start "$name"
    else
      podman run -d --name "$name" --init --shm-size=512m \
        --publish "127.0.0.1:$port:6080" \
        --publish "127.0.0.1:1455:1456" \
        --health-cmd 'curl --fail --silent http://127.0.0.1:6080/vnc.html > /dev/null && pgrep -x dyad > /dev/null' \
        --health-interval=30s --health-timeout=5s --health-start-period=90s \
        --health-retries=3 \
        --volume "$volume:/home/node" \
        --volume "$app_artifacts_dir:/home/node/dyad-apps" \
        --volume "$repo_root/containers/desktop.sh:/opt/dyad/containers/desktop.sh:ro" \
        --volume "$repo_root/containers/keyring-preflight.cjs:/opt/dyad/containers/keyring-preflight.cjs:ro" \
        --volume "$repo_root/containers/oauth-callback-proxy.cjs:/opt/dyad/containers/oauth-callback-proxy.cjs:ro" \
        --volume "$proxy_socket:/run/dyad-secrets-bus:ro" \
        --volume "$repo_root/containers/bin:/opt/dyad/containers/bin:ro" \
        --volume "$open_uri_socket:/run/dyad-open-uri.sock" \
        --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dyad-secrets-bus \
        "${gemini_env_args[@]}" \
        "$image"
    fi
    printf 'GNOME Secret Service is available through a filtered D-Bus proxy.\n'
    printf 'Provider sign-in opens in the host browser; OAuth callback is published on host loopback only.\n'
    printf 'Dyad desktop: http://127.0.0.1:%s/vnc.html?autoconnect=1&resize=remote\n' "$port"
    ;;
  stop)
    if podman container exists "$name"; then
      podman stop "$name"
    fi
    stop_keyring_proxy
    stop_open_uri_bridge
    ;;
  logs) podman logs --tail 100 -f "$name" ;;
  status) podman inspect "$name" --format '{{.State.Status}} {{.State.Health.Status}}' ;;
  shell) podman exec -it "$name" bash ;;
  dev-image)
    podman build --target development -f "$repo_root/containers/Containerfile" \
      -t "${DYAD_DEV_IMAGE:-localhost/dyad:dev}" "$repo_root"
    ;;
  check)
    # Use a disposable development image: packaging rebuilds SQLite for Electron,
    # whereas unit tests need its Node ABI.
    podman run --rm --entrypoint bash "${DYAD_DEV_IMAGE:-localhost/dyad:dev}" -lc \
      'npm run fmt:check && npm run lint && npm run ts && node --test containers/oauth-callback-proxy.test.cjs scripts/paperclip-project.test.mjs scripts/podman-open-uri.test.mjs'
    ;;
  *)
    printf 'Usage: bash scripts/podman-local.sh {build|up|stop|logs|status|shell|dev-image|check}\n'
    ;;
esac
