import { i18n } from '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { webBaseUrl, webOriginHeaders } from '@renderer/lib/web-base-url'
import {
  NAS_FILE_API,
  nasFileActionResultSchema,
} from '@shared/schemas/nas-files'

export const isSynology = () =>
  useOperatorSession.getState().status?.mode === 'synologyDsm'
export const hasHostFileActions = () =>
  __MOTRIX_TARGET__ === 'electron' ||
  useOperatorSession.getState().status?.mode === 'fnosGateway' ||
  useOperatorSession.getState().status?.nasCapabilities?.fileActions === true
export const hasNasTorrentPicker = () =>
  useOperatorSession.getState().status?.mode === 'fnosGateway' ||
  useOperatorSession.getState().status?.nasCapabilities?.torrentPicker === true
export const hostOpenFileLabelKey = () =>
  isSynology()
    ? 'panel.downloads.action.downloadToDevice'
    : 'panel.downloads.action.openFile'
export const hostRevealFolderLabelKey = () =>
  isSynology()
    ? 'panel.downloads.action.revealInFileStation'
    : 'panel.downloads.action.openFolder'

export async function nasRequest(
  route: 'task-action' | 'torrent',
  body: object
): Promise<Response> {
  const prefix =
    useOperatorSession.getState().status?.mode === 'fnosGateway'
      ? '/api/fnos'
      : NAS_FILE_API
  const response = await fetch(`${webBaseUrl()}${prefix}/${route}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...webOriginHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('NAS file request rejected')
  return response
}

export async function synologyFileAction(
  taskId: string,
  action: 'open' | 'reveal'
): Promise<void> {
  const popup =
    action === 'reveal' ? window.open('about:blank', '_blank') : null
  if (action === 'reveal' && !popup)
    throw new Error(i18n.t('panel.downloads.action.fileStationWindowBlocked'))
  if (popup) popup.opener = null
  try {
    const result = nasFileActionResultSchema.parse(
      await (await nasRequest('task-action', { taskId, action })).json()
    )
    const url = new URL(result.url, location.origin)
    if (
      url.origin !== location.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Invalid NAS file target')
    if (action === 'reveal') {
      if (
        result.kind !== 'file-manager' ||
        url.pathname !== '/' ||
        url.searchParams.get('launchApp') !==
          'SYNO.SDS.App.FileStation3.Instance'
      )
        throw new Error('Invalid File Station target')
      popup?.location.replace(url.href)
    } else {
      if (
        result.kind !== 'download' ||
        url.pathname !==
          `/motrix${NAS_FILE_API}/tasks/${encodeURIComponent(taskId)}/file` ||
        url.search
      )
        throw new Error('Invalid download target')
      const link = document.createElement('a')
      link.href = url.href
      link.download = ''
      link.rel = 'noopener noreferrer'
      document.body.append(link)
      link.click()
      link.remove()
    }
  } catch {
    popup?.close()
    throw new Error(i18n.t('panel.downloads.action.nasFileUnavailable'))
  }
}
