# Flatpak installation

[简体中文](flatpak.zh-CN.md)

Download the application bundle from a [Motrix GitHub release](https://github.com/agalwood/Motrix/releases)
that includes `.flatpak` assets. The 2.0 beta releases up to beta.39 contain only the
Native Host companion, which cannot install the application.

| `uname -m` | Application bundle | Optional browser companion |
|------------|--------------------|----------------------------|
| `x86_64` | `Motrix-<version>-x86_64.flatpak` | `Motrix-Native-Host-<version>-linux-x64.tar.gz` |
| `aarch64` | `Motrix-<version>-aarch64.flatpak` | `Motrix-Native-Host-<version>-linux-arm64.tar.gz` |

## Install and run

Install Flatpak using your distribution's package manager. Add Flathub for the
shared runtime, then install the downloaded application as your normal user.
Replace the placeholders with the actual filename:

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user --or-update ./Motrix-<version>-<arch>.flatpak
flatpak run app.motrix.native
```

The application ID is `app.motrix.native`. Beta bundles use the `beta` Flatpak
branch; stable versions use `stable`. Use one branch at a time when integrating
with the browser companion. Adding Flathub here provides dependencies; it does
not install the older `net.agalwood.Motrix` application or publish Motrix 2.x to
Flathub. The old ID is a separate application, not an automatic upgrade path.

The sandbox permits access to Downloads by default. Select other directories
through the file chooser portal. Application data is stored beneath
`~/.var/app/app.motrix.native/`; switching packaging formats does not migrate
existing Motrix data automatically.

## Browser extension

Ordinary downloads do not need the companion. To enable the supported host
browsers' Native Messaging integration, first install the application, then
download the matching version and architecture of the Native Host companion.
Follow the [companion installation guide](../packages/native-host/README.md).

The application bundle contains the in-sandbox broker. The companion runs
outside the sandbox and is installed separately by the user. Neither component
replaces the other; installing just the `.tar.gz` does not install Motrix.

## Upgrade and remove

Quit Motrix, download a newer `.flatpak` for the same architecture and branch,
and install it with the same `flatpak install --user --or-update ./…flatpak` command.
Flatpak will offer to update the existing installation. Update an installed
browser companion separately using its documented `install --force` command.

These bundles do not configure a Motrix remote. `flatpak update` can update
shared runtimes, but does not discover newer Motrix bundles on GitHub.
Download each application update from Releases.

```bash
flatpak uninstall --user app.motrix.native
```

Uninstall the companion separately if you installed it. Do not add
`--delete-data` unless you intend to remove the application's saved data.

## Build and release checks

The release workflow calls the same native x86_64/aarch64 Flatpak workflow used
by PR CI. It archives the release event's commit, verifies its package version
against release preflight and AppStream metadata, and pins the source archive
checksum. Each bundle is installed and checked for application ID, architecture,
branch, version, aria2 features, and the private broker protocol. x86_64 also
checks the host-side companion's framed Native Messaging exchange.

Both bundles must succeed before release assembly and publication. They are
required release assets, separate from Electron's updater manifests. Manual
release workflow runs validate the build without publishing. These checks do
not replace interactive desktop testing of portals, tray behavior, or browser
pairing.
