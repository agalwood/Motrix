export interface WindowsDefaultAssociations {
  supported: boolean
  registered: boolean | null
  scope: 'user' | 'machine' | null
  torrent: boolean | null
  magnet: boolean | null
}
