import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { sha256File } from './plugin-install-file'
import type { PlatformServices } from './services'

export const electronServices: PlatformServices = {
  kind: 'electron',

  pluginInstallFile: {
    mode: 'local-path',
    async prepare(file) {
      const absPath = window.motrix?.getPathForFile?.(file)
      if (!absPath) {
        throw new Error('Desktop file path capability is unavailable')
      }
      return {
        sourceType: 'local',
        absPath,
        fileHash: await sha256File(file),
      }
    },
  },

  async pickSaveDir(defaultPath) {
    const res = await transport.invoke(Commands.PickSaveDir, { defaultPath })
    if (res && typeof res === 'object' && 'path' in res) {
      return (res as { path: string }).path
    }
    return null
  },

  async closeHost(options = { showMain: true }) {
    await transport.invoke(Commands.CloseCurrentWindow, options)
  },

  async readClipboard() {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  },

  async openExternal(url) {
    await transport.invoke(Commands.OpenExternal, url)
  },

  notify(kind, messageKey, values) {
    const msg = i18n.t(messageKey, values)
    if (kind === 'error') toast.add({ title: msg, type: 'error' })
    else if (kind === 'warn') toast.add({ title: msg, type: 'warning' })
    else toast.add({ title: msg, type: 'info' })
  },
}
