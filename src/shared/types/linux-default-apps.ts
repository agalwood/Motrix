export type LinuxPackageKind =
  | 'appimage'
  | 'native'
  | 'flatpak'
  | 'snap'
  | 'unknown'

export interface LinuxDefaultAssociations {
  supported: boolean
  packageKind: LinuxPackageKind | null
  registered: boolean
  canSetTorrentDefault: boolean
  torrent: boolean | null
  magnet: boolean | null
}
