# Flatpak Native Messaging companion

Motrix's Flatpak browser integration has two deliberately separate layers:

1. `motrix-flatpak-native-host` runs outside the Flatpak sandbox as the browser's Native Messaging host. It owns the browser manifests, launches the fixed Motrix Flatpak application, and forwards only the framed pairing request.
2. `motrix-native-host-broker` runs inside Motrix's Flatpak sandbox. It resolves the bridge endpoint, performs the localhost health check, and obtains the one-time nonce. The companion does not reimplement or weaken this security boundary.

The GitHub Release publishes a standalone archive for each supported 64-bit Linux architecture:

- `Motrix-Native-Host-<version>-linux-x64.tar.gz`
- `Motrix-Native-Host-<version>-linux-arm64.tar.gz`

Each archive includes the project license, bilingual third-party notices, and the complete third-party license texts required by the Rust executables.

## Install

Install the Motrix Flatpak first, then download the archive matching the host CPU from the same Motrix GitHub Release:

```sh
tar -xzf Motrix-Native-Host-<version>-linux-<arch>.tar.gz
cd Motrix-Native-Host-<version>-linux-<arch>
./motrix-flatpak-native-host install
./motrix-flatpak-native-host status
```

The installer copies the companion to:

```text
$XDG_DATA_HOME/motrix/native-messaging/motrix-flatpak-native-host
```

When `XDG_DATA_HOME` is unset, it uses `~/.local/share`. Configuration is stored at `$XDG_CONFIG_HOME/motrix/native-messaging/flatpak-companion.json`, falling back to `~/.config`. The installer writes user-level Native Messaging manifests for Chrome, Chromium, Edge, and Firefox.

If Flatpak is installed at a nonstandard absolute path, use:

```sh
./motrix-flatpak-native-host install --flatpak-bin /absolute/path/to/flatpak
```

Use `--force` only when intentionally replacing an existing companion configuration. To remove the installed binary, configuration, and managed manifests:

```sh
./motrix-flatpak-native-host uninstall
```

Run `./motrix-flatpak-native-host --help` for the complete command reference.

## Security and lifecycle notes

The Flatpak application cannot install this host-side component or browser manifests by itself. Installation is an explicit host-user action. The companion is a native executable and does not depend on Node.js, Electron, a downloaded runtime, or an interpreter from `PATH`; its only configurable external executable is an explicitly validated absolute Flatpak path.

Installation rejects symlinked, foreign-owned, or group/other-writable path components. Newly created private directories use mode `0700`; the installed companion uses `0700`, and its configuration and manifests use `0600`, independently of the caller's umask. A custom Flatpak executable is stored by canonical path and is revalidated whenever the companion runs.

The standard manifests cover browsers installed directly on the host. A browser that is itself sandboxed may require its distribution's separately trusted Native Messaging proxy and is not enabled by this archive alone.

The companion registers only Motrix's built-in official extension identities. Custom extension IDs added inside the Flatpak app are not synchronized to the host companion and therefore are not registered by this installer.

After upgrading the companion archive, run `install --force`, then `status`. The normal Motrix `.deb` and `.rpm` packages do not contain this Flatpak-only companion.

Once installed, the companion retains ownership of Motrix's shared Linux browser manifests. A `.deb`, `.rpm`, or Snap Motrix instance will not replace or remove companion-owned manifests. Uninstall the companion before intentionally switching browser integration back to a non-Flatpak installation.
