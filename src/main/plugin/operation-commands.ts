import path from 'node:path'
import { operationHandlers } from '@core/plugin/operations/operation-handlers'
import type { OperationService } from '@core/plugin/operations/operation-service'
import { Commands } from '@shared/protocol/commands'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import { operationPickSchema } from '@shared/schemas/plugin-operations'
import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { z } from 'zod'
import { i18n } from '../lib/i18n'
export function desktopOperationHandlers(
  service: OperationService
): CommandHandlerMap {
  const owner = (sender: WebContents) => ({
    id: `electron:${sender.id}`,
    eligible: () => !sender.isDestroyed(),
  })
  const handlers: CommandHandlerMap = {}
  for (const [channel, handler] of Object.entries(operationHandlers(service))) {
    handlers[channel as keyof CommandHandlerMap] = async (
      sender: WebContents,
      value: unknown
    ) => handler(owner(sender), value)
  }
  handlers[Commands.RevealPluginOperation] = async (
    sender: WebContents,
    value: unknown
  ) => {
    const output = service.output(owner(sender), String(value))
    shell.showItemInFolder(output)
  }
  const choosing = new Set<number>()
  handlers[Commands.PickPluginOperationFile] = async (
    sender: WebContents,
    value: unknown
  ) => {
    const { dropCandidate, ...request } = operationPickSchema
      .omit({ candidate: true })
      .extend({ dropCandidate: z.string().min(1).max(4096).optional() })
      .parse(value)
    if (choosing.has(sender.id)) return null
    choosing.add(sender.id)
    try {
      const picker = service.picker(owner(sender), request)
      const options = {
        defaultPath: picker.defaultPath,
        filters: picker.extensions?.length
          ? [
              {
                name: i18n.t('directoryPicker.files'),
                extensions: picker.extensions,
              },
            ]
          : undefined,
      }
      const parent = BrowserWindow.fromWebContents(sender)
      let candidate: string | undefined
      if (dropCandidate) {
        if (
          picker.kind !== 'open' ||
          !path.isAbsolute(dropCandidate) ||
          dropCandidate.includes('\0')
        )
          throw new Error('pluginOperations.invalidFile')
        const options = {
          type: 'question' as const,
          title: i18n.t('pluginOperations.confirmFileTitle'),
          message: i18n.t('pluginOperations.confirmFile'),
          detail: `${service.selectionIdentity(owner(sender), request)}\n\n${path.normalize(dropCandidate)}`,
          buttons: [i18n.t('common.cancel'), i18n.t('common.confirm')],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        }
        const result = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options)
        if (result.response === 1) candidate = path.normalize(dropCandidate)
      } else if (picker.kind === 'save') {
        const result = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        if (!result.canceled) candidate = result.filePath
      } else {
        const params = { ...options, properties: ['openFile' as const] }
        const result = parent
          ? await dialog.showOpenDialog(parent, params)
          : await dialog.showOpenDialog(params)
        if (!result.canceled) candidate = result.filePaths[0]
      }
      return candidate
        ? service.pick(owner(sender), { ...request, candidate })
        : null
    } finally {
      choosing.delete(sender.id)
    }
  }
  return handlers
}
