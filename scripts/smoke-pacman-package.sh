#!/usr/bin/env bash
set -euo pipefail

# The official Arch Linux image is x86_64. ARM archives are inspected by the
# cross-platform verifier on their native build runner, not run under emulation.
artifact_dir="$(cd "${1:?Expected release directory}" && pwd)"
shopt -s nullglob
packages=("$artifact_dir"/*-x64.pacman)
if (( ${#packages[@]} != 1 )); then
  echo 'Expected exactly one x64 pacman package' >&2
  exit 1
fi

docker run --rm --platform linux/amd64 \
  --mount "type=bind,src=$artifact_dir,dst=/artifacts,readonly" \
  --env "MOTRIX_PACKAGE=/artifacts/$(basename "${packages[0]}")" \
  archlinux:base bash -euo pipefail -c '
    pacman -Syu --noconfirm
    pacman -U --noconfirm "$MOTRIX_PACKAGE"
    pacman -Qk motrix
    test "$(readlink -f /usr/bin/motrix)" = /opt/Motrix/motrix
    test -f /usr/share/applications/motrix.desktop
    test -f /usr/share/icons/hicolor/256x256/apps/motrix.png
    test "$(cat /opt/Motrix/resources/package-type)" = pacman
    ldd /opt/Motrix/motrix > /tmp/motrix-ldd.log
    cat /tmp/motrix-ldd.log
    if grep -q "not found" /tmp/motrix-ldd.log; then
      echo "Packaged Electron has unresolved runtime dependencies" >&2
      exit 1
    fi
    /opt/Motrix/resources/extra/linux/x64/aria2c --version
    # Reinstallation exercises post_upgrade as well as post_install.
    pacman -U --noconfirm "$MOTRIX_PACKAGE"
    test -x /usr/bin/motrix
    pacman -R --noconfirm motrix
    test ! -e /opt/Motrix
    test ! -e /usr/share/applications/motrix.desktop
    test ! -L /usr/bin/motrix
  '
