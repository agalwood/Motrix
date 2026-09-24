# Arch Linux and Omarchy

[简体中文](arch-linux.zh-CN.md)

Omarchy uses Arch Linux packages and `pacman`. Motrix release builds include a
native `.pacman` package for `x64` (`x86_64`) and `arm64` (`aarch64`). Download it
from the assets of a [GitHub release](https://github.com/agalwood/Motrix/releases)
that includes this format. Older releases may only offer AppImage, DEB, and RPM.

The `.pacman` suffix is electron-builder’s name for a native Arch package. The
archive uses Zstandard compression and contains Arch package metadata, just as
a `.pkg.tar.zst` package does. Keep the published filename: Motrix’s application
updater selects the `.pacman` asset from the release manifest.

## Install

Run `uname -m` to check your architecture. Choose `x64` for `x86_64`, or `arm64`
for `aarch64` (the ARM filename uses `aarch64`). Update Omarchy through its Update menu before installing; on
ordinary Arch Linux, run `sudo pacman -Syu`.

In the directory containing the download, replace the placeholders with its
actual filename:

```bash
sudo pacman -U ./Motrix-<version>-<arch>.pacman
motrix
```

Pacman installs the application in `/opt/Motrix`, adds the `motrix` command,
and installs the launcher, icons, and torrent/Magnet/Motrix URL handlers. The
package includes its own Electron runtime, aria2, and native helpers. Pacman
resolves the declared system libraries; a separate system Electron package is
not needed. Run Motrix as your normal user.

For a system tray that requires AppIndicator support, install the optional
`libayatana-appindicator` package. Browser extension pairing is configured in
Motrix’s Integration settings after launch.

## Update and remove

Install a newer downloaded `.pacman` file using the same `pacman -U` command.
The package also carries the metadata for Motrix’s application update flow.
Because a downloaded package is not a configured package repository, `pacman
-Syu` alone does not fetch newer Motrix releases.

```bash
sudo pacman -R motrix
```

Removing the package removes the installed application and desktop entry.
Your downloads and user configuration remain in your user directories.
Existing AUR variants such as `motrix-bin` are declared as conflicts so pacman
can resolve the transition instead of allowing overlapping installations.

## Building and verification

After building and staging the Linux desktop application, package it on the
matching Linux architecture. The release workflow supplies the native build
inputs and packaging tools (`zstd` and `bsdtar`, provided by `libarchive` on
Arch or `libarchive-tools` on Ubuntu):

```bash
pnpm exec electron-builder --linux pacman --x64 --publish never
node scripts/verify-pacman-artifact.mjs --dir release --version <version> --arch x64
bash scripts/smoke-pacman-package.sh release
```

Use `--arm64` and `--arch arm64` for ARM builds. CI and the release workflow
inspect both architectures’ final archives, metadata, desktop handlers, and
Electron/native payloads. The Docker smoke test uses the official x86_64 Arch
image to check installation, shared-library resolution, aria2 execution,
reinstallation, and removal. It does not validate a full Omarchy/Hyprland GUI
session; tray behavior, Wayland rendering, and browser pairing still need
desktop testing. The ARM package does not run through that x86_64 install test.

These artifacts are distributed through Motrix releases. This does not publish
or update an AUR entry or add Motrix to Omarchy’s package repository.
