/**
 * Minimum structural shape required by the FileList component.
 * Both TorrentFileInfo (add-task) and TaskFile (detail) extend this.
 */
export interface BaseFileRow {
  index: number
  path: string
  size: number
}
