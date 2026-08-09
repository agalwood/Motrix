import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import {
  type AddTaskFormValues,
  magnetFileSelectionPayloadSchema,
  protocolTorrentFilePayloadSchema,
  setAddTaskModeEventPayloadSchema,
  urlParamsToFormDefaults,
} from '@shared/schemas/add-task'
import { useEffect } from 'react'
import type { UseFormReturn } from 'react-hook-form'

export function useExternalHydration(
  form: UseFormReturn<AddTaskFormValues>,
  enabled: boolean
) {
  useEffect(() => {
    if (!enabled) return

    const onMagnet = (...args: unknown[]) => {
      const parsed = magnetFileSelectionPayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      form.reset(
        {
          tab: 'torrent',
          source: 'magnet',
          magnetUri: parsed.data.magnetUri,
          base64: parsed.data.torrentBase64,
          torrentMeta: parsed.data.meta,
          selectedFiles: parsed.data.meta.files.map((f) => f.index),
          saveDir: parsed.data.saveDir,
          // Plan B: thread the metadata pending task's motrixId
          // through so the CreateTask handler can swap the instance
          // in place instead of creating a duplicate row.
          existingTaskId: parsed.data.taskId,
        },
        { keepErrors: false }
      )
    }

    const onProtocol = (...args: unknown[]) => {
      const parsed = protocolTorrentFilePayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      form.reset(
        {
          tab: 'torrent',
          source: 'file',
          base64: parsed.data.payload.dataBase64,
          torrentMeta: parsed.data.meta,
          selectedFiles: parsed.data.meta.files.map((f) => f.index),
          saveDir: form.getValues('saveDir'),
        },
        { keepErrors: false }
      )
    }

    const onSetMode = (...args: unknown[]) => {
      const parsed = setAddTaskModeEventPayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      const defaults = urlParamsToFormDefaults(parsed.data)
      // A mode switch without an explicit saveDir must not wipe whatever
      // is already in the field (e.g. the user's defaultSaveDir that the
      // form backfilled at mount). Symmetric to onProtocol below.
      if (defaults.saveDir === undefined) {
        defaults.saveDir = form.getValues('saveDir')
      }
      form.reset(defaults as Partial<AddTaskFormValues>, {
        keepErrors: false,
      })
    }

    transport.on(Events.MagnetFileSelection, onMagnet)
    transport.on(Events.ProtocolTorrentFile, onProtocol)
    transport.on(Events.SetAddTaskMode, onSetMode)

    return () => {
      transport.off(Events.MagnetFileSelection, onMagnet)
      transport.off(Events.ProtocolTorrentFile, onProtocol)
      transport.off(Events.SetAddTaskMode, onSetMode)
    }
  }, [form, enabled])
}
