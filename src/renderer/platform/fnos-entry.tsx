import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { readTorrentFile } from '@renderer/lib/parse-torrent-file'
import { torrentFileErrorKey } from '@shared/lib/engine-torrent'
import { useEffect } from 'react'
import { fnosRequest, fnosSdk, isFnos } from './fnos'
import { usePlatformServices } from './services'

/** File associations open a draft; they never submit a download automatically. */
export function FnosEntry() {
  const services = usePlatformServices()
  useEffect(() => {
    if (!isFnos()) return
    let active = true
    void (async () => {
      const sdk = await fnosSdk()
      const callback = sdk.parseAppAuthCallback(location.href)
      if (
        callback.state &&
        callback.method === 'pickSharedFile' &&
        callback.appName === 'motrix'
      ) {
        window.opener?.postMessage(
          { type: 'motrix:fnos-auth', result: callback },
          location.origin
        )
        history.replaceState(null, '', `${location.pathname}${location.hash}`)
        window.close()
        return
      }
      const candidate = new URL(location.href).searchParams.get('path')
      if (!candidate || !active) return
      const response = await fnosRequest('torrent', { path: candidate })
      const file = new File(
        [await response.blob()],
        candidate.split('/').at(-1) ?? 'download.torrent'
      )
      const parsed = await readTorrentFile(file)
      if (!active || useAddTaskDialogStore.getState().open) return
      history.replaceState(null, '', `${location.pathname}${location.hash}`)
      useAddTaskDialogStore.getState().openWith({ tab: 'torrent' }, [parsed])
    })().catch((error) => {
      if (active) services.notify('error', torrentFileErrorKey(error))
    })
    return () => {
      active = false
    }
  }, [services])
  return null
}
