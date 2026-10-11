import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type {
  OperationDescriptor,
  OperationJob,
} from '@shared/schemas/plugin-operations'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invokeOperation } from './operation-client'

interface OperationState {
  descriptors: OperationDescriptor[]
  jobs: OperationJob[]
}

/** Reconcile operation presentation after lifecycle changes and Web reconnects. */
export function useOperationState() {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage
  const [snapshot, setSnapshot] = useState<OperationState>()
  const [failed, setFailed] = useState(false)
  const retry = useRef(() => {})
  useEffect(() => {
    let active = true
    let generation = 0
    let running = false
    const refresh = async () => {
      ++generation
      if (running) return
      running = true
      let requested: number
      do {
        requested = generation
        try {
          const next = await invokeOperation<OperationState>(
            Commands.GetPluginOperations
          )
          if (active && requested === generation) {
            setSnapshot(next)
            setFailed(false)
          }
        } catch {
          if (active && requested === generation) setFailed(true)
        }
      } while (active && requested !== generation)
      running = false
    }
    const onChanged = () => void refresh()
    retry.current = onChanged
    const channels = [
      Events.PluginInstalled,
      Events.PluginUninstalled,
      Events.PluginStatusChanged,
      Events.PluginGrantsChanged,
      Events.PluginSecurityChanged,
      Events.ContributionIndexChanged,
      Events.FfmpegInstallStatusChanged,
    ]
    for (const channel of channels) transport.on(channel, onChanged)
    const unsubscribe = transport.onConnectionChange?.(({ state }) => {
      if (state === 'connected') onChanged()
    })
    if (locale) onChanged()
    return () => {
      active = false
      retry.current = () => {}
      for (const channel of channels) transport.off(channel, onChanged)
      unsubscribe?.()
    }
  }, [locale])
  return { snapshot, failed, retry: () => retry.current() }
}
