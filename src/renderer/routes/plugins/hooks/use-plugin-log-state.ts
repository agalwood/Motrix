import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type PluginLogState,
  PluginLogStateSchema,
} from '@shared/schemas/plugin-logs'
import { useEffect, useRef, useState } from 'react'

const OFF: PluginLogState = { verbose: false, expiresAt: null }

/** Host-owned expiry survives tab remounts and cannot be extended by rendering. */
export function usePluginLogState(pluginId: string) {
  const [snapshot, setSnapshot] = useState({ pluginId, state: OFF })
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const mutation = useRef(false)
  const activePlugin = useRef(pluginId)
  activePlugin.current = pluginId
  const state = snapshot.pluginId === pluginId ? snapshot.state : OFF

  useEffect(() => {
    let cancelled = false
    setPending(false)
    mutation.current = false
    const refresh = async () => {
      if (mutation.current) return
      const request = ++generation.current
      try {
        const result = PluginLogStateSchema.parse(
          await transport.invoke(Queries.GetPluginLogState, { pluginId })
        )
        if (!cancelled && request === generation.current)
          setSnapshot({ pluginId, state: result })
      } catch {
        // Keep the last host snapshot; reconnect/focus or the next poll retries.
      }
    }
    void refresh()
    // Synchronize toggles made in another client, including a disabled -> enabled change.
    const poll = setInterval(() => void refresh(), 10_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const unsubscribe = transport.onConnectionChange?.(({ state }) => {
      if (state === 'connected') void refresh()
    })
    return () => {
      cancelled = true
      generation.current += 1
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      unsubscribe?.()
    }
  }, [pluginId])

  useEffect(() => {
    if (state.expiresAt === null) return
    const timer = setTimeout(
      () => {
        setSnapshot((current) =>
          current.pluginId === pluginId &&
          current.state.expiresAt === state.expiresAt
            ? { pluginId, state: OFF }
            : current
        )
      },
      Math.max(0, state.expiresAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [pluginId, state.expiresAt])

  async function setVerbose(verbose: boolean) {
    if (mutation.current) return
    mutation.current = true
    const request = ++generation.current
    setPending(true)
    try {
      const result = PluginLogStateSchema.parse(
        await transport.invoke(Commands.SetPluginLogVerbose, {
          pluginId,
          verbose,
        })
      )
      if (request === generation.current && activePlugin.current === pluginId)
        setSnapshot({ pluginId, state: result })
    } catch {
      // A failed command must not make the switch claim capture is enabled.
    } finally {
      if (request === generation.current && activePlugin.current === pluginId) {
        mutation.current = false
        setPending(false)
      }
    }
  }

  return { verbose: state.verbose, pending, setVerbose }
}
