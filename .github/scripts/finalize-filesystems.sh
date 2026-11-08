#!/usr/bin/env bash
# Only newly allocated image files are formatted; never accept a device path.
set -euo pipefail
filesystem=${1:?expected a filesystem name}
shift
case "$filesystem" in
  ext4|btrfs|xfs|f2fs|exfat|vfat|ntfs3|ntfs-3g|tmpfs|overlay) ;;
  *) echo "Unsupported matrix filesystem: $filesystem" >&2; exit 2 ;;
esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/motrix-fs-matrix-XXXXXX")
privilege=()
if [ "$(id -u)" != 0 ]; then privilege=(sudo); fi
mounted=false
bound=false
backing=false
cleanup() {
  # Do not remove paths beneath a mount that could not be detached.
  if [ "$bound" = true ]; then "${privilege[@]}" umount "$scratch/bind" || return 1; fi
  if [ "$mounted" = true ]; then "${privilege[@]}" umount "$scratch/volume" || return 1; fi
  if [ "$backing" = true ]; then "${privilege[@]}" umount "$scratch/backing" || return 1; fi
  "${privilege[@]}" rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/volume" "$scratch/bind" "$scratch/backing"
uid=$(id -u)
gid=$(id -g)
if [ "$filesystem" = tmpfs ]; then
  "${privilege[@]}" mount -t tmpfs -o "size=64m,uid=$uid,gid=$gid" tmpfs "$scratch/volume"
elif [ "$filesystem" = overlay ]; then
  # Overlay upper/work must live on a real supported backing filesystem,
  # not the runner's possibly nested overlay/virtiofs checkout.
  truncate -s 512M "$scratch/backing.img"
  mkfs.ext4 -F -q "$scratch/backing.img"
  "${privilege[@]}" mount -o loop "$scratch/backing.img" "$scratch/backing"
  backing=true
  "${privilege[@]}" mkdir "$scratch/backing/lower" "$scratch/backing/upper" "$scratch/backing/work"
  "${privilege[@]}" mount -t overlay overlay -o "lowerdir=$scratch/backing/lower,upperdir=$scratch/backing/upper,workdir=$scratch/backing/work" "$scratch/volume"
else
  truncate -s 512M "$scratch/disk.img"
  options=loop
  case "$filesystem" in
    ext4) mkfs.ext4 -F -q "$scratch/disk.img" ;;
    btrfs) mkfs.btrfs -f -q "$scratch/disk.img" ;;
    xfs) mkfs.xfs -f -q "$scratch/disk.img" ;;
    f2fs) mkfs.f2fs -q "$scratch/disk.img" ;;
    exfat) mkfs.exfat "$scratch/disk.img" ;;
    vfat) mkfs.vfat -F 32 "$scratch/disk.img" ;;
    ntfs3|ntfs-3g) mkfs.ntfs -F -Q -q "$scratch/disk.img" ;;
  esac
  case "$filesystem" in
    exfat|vfat|ntfs3|ntfs-3g) options="$options,uid=$uid,gid=$gid,umask=022" ;;
  esac
  "${privilege[@]}" mount -t "$filesystem" -o "$options" "$scratch/disk.img" "$scratch/volume"
fi
mounted=true
case "$filesystem" in
  exfat|vfat|ntfs3|ntfs-3g) ;;
  *) "${privilege[@]}" chown "$uid:$gid" "$scratch/volume" ;;
esac
"${privilege[@]}" mount --bind "$scratch/volume" "$scratch/bind"
bound=true
findmnt --target "$scratch/volume"
export MOTRIX_FINALIZE_MATRIX_ROOT="$scratch/volume"
export MOTRIX_FINALIZE_MATRIX_BIND_ROOT="$scratch/bind"
export MOTRIX_FINALIZE_MATRIX_TYPE="$filesystem"
pnpm exec vitest run src/core/plugin/finalize/finalize-filesystems.integration.test.ts "$@" --reporter=verbose
