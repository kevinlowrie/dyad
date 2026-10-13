# Run Dyad in Podman

Dyad is an Electron desktop application. The supplied image packages the Linux
app and runs it under Xvfb, Fluxbox, and noVNC so you can use the real renderer,
main-process IPC, SQLite database, and built-in terminal in a browser.

Run these commands from the repository root:

```sh
bash scripts/podman-local.sh build
bash scripts/podman-local.sh up
```

Open <http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote>. The image
build uses the Node 24 release required by `package.json`, installs pinned npm
dependencies, and packages the app for Linux. The build takes a few minutes on
the first run. Your app settings, SQLite database, and generated projects live
in the `dyad-local-home` Podman volume and survive image rebuilds.

When started from a logged-in GNOME desktop, the launcher gives Dyad a filtered
D-Bus proxy for `org.freedesktop.secrets`. Electron is told to use its
`gnome-libsecret` backend, so its encryption key can live in the host GNOME
keyring. The host keyring must be running and unlocked. The full desktop bus
and host home directory are not mounted into the container. If the Secret
Service or Electron encryption is unavailable, the container stops at startup
instead of silently launching this local setup with plaintext fallback
storage. The host needs `xdg-dbus-proxy`, `busctl`, and a systemd user session.
When `GEMINI_API_KEY` is exported in the host shell, `up` passes it through to
Dyad so the Google provider can use it without re-entering the key in settings.
Provider sign-in links open in the host's default browser through a small local
bridge, so an existing ChatGPT session can be reused. ChatGPT's OAuth callback
is forwarded from host `127.0.0.1:1455` to the app's loopback listener; no
external network interface publishes that callback port. The launcher also
needs the host's `xdg-open`, Node.js, and systemd user session.

Electron stores provider credentials encrypted in Dyad's app data; the key
used for that encryption is what GNOME Keyring protects. This does not import
old plaintext credentials into separate keyring entries. Reconnect providers
or re-enter credentials that were saved before the keyring proxy was enabled,
and check Dyad's plaintext-storage warning before saving secrets.

Use `bash scripts/podman-local.sh status`, `logs`, `shell`, and `stop` to
inspect or operate the desktop. `dev-image` builds an image with the source and
Node development tools. `check` runs the formatting, lint, type-check, and
Paperclip registration tests in that development image. `DYAD_DESKTOP_PORT`
changes the loopback-only browser port; `DYAD_SCREEN_SIZE` changes the virtual
screen size when launching the container.

The container runs as the unprivileged `node` user. Electron uses Chromium's
`--no-sandbox` flag because nested user namespaces are not available on every
rootless Podman host. Podman supplies the outer container boundary. App
projects created in the container are stored in `~/src.d/dyad-apps` on the
host, mounted at `/home/node/dyad-apps`; ACLs preserve access for the host user
and the container's rootless UID mapping. Set `DYAD_APP_ARTIFACTS_DIR` to use a
different host directory.

## Connect the Paperclip Developer Team

`node scripts/paperclip-project.mjs sync` uses the local board credential in
`~/.config/homelab/agent-workers/paperclip.env`. It creates or reuses a Dyad
project in the current Paperclip company, led by its existing OpenCode agent,
and adds the official Dyad GitHub repository as the primary workspace. The
registration is safe to repeat. The credential stays on the host and is never
mounted in the app container.

The staff's repository worker accepts committed source snapshots by short name.
Install a committed checkout as `.state/agent-workers/repos/dyad` in the
homelab checkout before assigning repository code work. The worker clones that
snapshot's HEAD, so it won't see uncommitted files from your host checkout. It
has no internet access or Podman socket; ask it to review or implement source
changes and build/test through its supported worker environment. Run and build
the desktop on the host/container.

After registration, submit work to the coordinator without sending any
provider or Paperclip credentials:

```sh
node scripts/paperclip-project.mjs submit complex-code /path/to/prompt.txt
node scripts/paperclip-project.mjs status <request-uuid>
```

The submit command prints the request ID so you can resume or check a job with
the same ID. The installed Developer Team applies its normal producer and
independent reviewer policy. Its on-demand local-model agents stay disabled
until their local model routes are configured.
