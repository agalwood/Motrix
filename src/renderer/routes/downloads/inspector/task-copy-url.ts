import { fetchTaskBtDetail } from '@renderer/hooks/use-task-bt-detail'
import { infoHashToMagnetUri } from '@renderer/lib/magnet'
import type { DownloadTask } from '@shared/types/task'
import { isTorrentLike } from '@shared/types/task-actions'

export async function getTaskCopyUrl(task: DownloadTask): Promise<string> {
  if (isTorrentLike(task)) {
    // Broadcasts omit magnet/tracker details. Resolve them at click time;
    // a failed fetch must never silently copy a tracker-less magnet.
    const detail = await fetchTaskBtDetail(task.id)
    if (detail.magnetUri) return detail.magnetUri
    if (task.infoHash) {
      return infoHashToMagnetUri(task.infoHash, {
        name: task.name,
        trackers: detail.announceList.flat(),
      })
    }
  }
  return task.uris[0] ?? ''
}

export async function copyTaskUrls(
  tasks: readonly DownloadTask[]
): Promise<void> {
  const urls = await Promise.all(tasks.map(getTaskCopyUrl))
  // Resolve the entire selection before replacing the clipboard.
  await navigator.clipboard.writeText(urls.join('\n'))
}
