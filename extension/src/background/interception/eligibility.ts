export interface DownloadItemLike {
  finalUrl?: string
  url: string
  byExtensionId?: string | undefined
}

/** The URL a takeover should act on: post-redirect finalUrl when present. */
export function pickDownloadUrl(item: DownloadItemLike): string {
  return item.finalUrl && item.finalUrl.length > 0 ? item.finalUrl : item.url
}

export function isEligibleDownload(
  item: DownloadItemLike,
  selfExtensionId: string
): boolean {
  if (item.byExtensionId === selfExtensionId) return false // loop guard: our own re-issued download
  const url = pickDownloadUrl(item)
  return url.startsWith('http://') || url.startsWith('https://')
}
