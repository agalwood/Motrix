import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginListDTO, PluginStatus } from '@shared/types/plugin'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PluginMetadataStatus = 'idle' | 'loading' | 'success' | 'error'

export interface PluginMetadataError {
  code: string
  message: string
}

export interface PluginMetadataState {
  data: PluginListDTO[] | null
  status: PluginMetadataStatus
  error: PluginMetadataError | null
  isRefreshing: boolean
  refresh(): Promise<void>
}

interface StatusChangedPayload {
  id?: string
  pluginId?: string
  status: PluginStatus
  enabled?: boolean
  lastError?: string
}

const METADATA_LOAD_ERROR_CODE = 'PLUGIN_METADATA_LOAD_FAILED'
const METADATA_LOAD_ERROR_MESSAGE = 'Plugin metadata request failed'

function normalizeMetadataError(error: unknown): PluginMetadataError {
  if (error instanceof Error) {
    return {
      code: METADATA_LOAD_ERROR_CODE,
      message: error.message || METADATA_LOAD_ERROR_MESSAGE,
    }
  }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown }
    return {
      code:
        typeof value.code === 'string' ? value.code : METADATA_LOAD_ERROR_CODE,
      message:
        typeof value.message === 'string'
          ? value.message
          : METADATA_LOAD_ERROR_MESSAGE,
    }
  }
  return {
    code: METADATA_LOAD_ERROR_CODE,
    message: METADATA_LOAD_ERROR_MESSAGE,
  }
}

export function usePluginMetadata(): PluginMetadataState {
  const [state, setState] = useState<Omit<PluginMetadataState, 'refresh'>>({
    data: null,
    status: 'idle',
    error: null,
    isRefreshing: false,
  })
  const mountedRef = useRef(false)
  const dataRef = useRef<PluginListDTO[] | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const requestVersionRef = useRef(0)
  const dirtyRef = useRef(false)

  const refresh = useCallback(function refreshMetadata(): Promise<void> {
    if (!mountedRef.current) return Promise.resolve()
    if (inFlightRef.current) return inFlightRef.current
    const requestVersion = ++requestVersionRef.current

    setState((current) =>
      dataRef.current
        ? {
            ...current,
            status: 'success',
            error: null,
            isRefreshing: true,
          }
        : {
            data: null,
            status: 'loading',
            error: null,
            isRefreshing: false,
          }
    )

    let request!: Promise<void>
    request = transport
      .invoke(Queries.ListPlugins)
      .then((response) => {
        if (
          !mountedRef.current ||
          requestVersionRef.current !== requestVersion
        ) {
          return
        }
        const data = response as PluginListDTO[]
        dataRef.current = data
        setState({
          data,
          status: 'success',
          error: null,
          isRefreshing: false,
        })
      })
      .catch((error: unknown) => {
        if (
          !mountedRef.current ||
          requestVersionRef.current !== requestVersion
        ) {
          return
        }
        setState((current) => ({
          ...current,
          status: 'error',
          error: normalizeMetadataError(error),
          isRefreshing: false,
        }))
      })
      .finally(() => {
        if (inFlightRef.current !== request) return
        inFlightRef.current = null
        if (
          !mountedRef.current ||
          requestVersionRef.current !== requestVersion ||
          !dirtyRef.current
        ) {
          return
        }
        dirtyRef.current = false
        void refreshMetadata()
      })
    inFlightRef.current = request
    return request
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()

    const refreshAfterEvent = () => {
      if (inFlightRef.current) {
        dirtyRef.current = true
        return
      }
      void refresh()
    }
    const onStatus = (...args: unknown[]) => {
      const payload = args[0] as StatusChangedPayload | undefined
      const pluginId = payload?.pluginId ?? payload?.id
      if (!pluginId || !payload) return
      const currentData = dataRef.current
      if (currentData) {
        const data = currentData.map((plugin) =>
          plugin.id === pluginId
            ? {
                ...plugin,
                status: payload.status,
                enabled: payload.enabled ?? plugin.enabled,
                lastError: payload.lastError,
              }
            : plugin
        )
        dataRef.current = data
        setState((current) => ({ ...current, data }))
      }
      refreshAfterEvent()
    }
    const onMetadataChanged = () => {
      refreshAfterEvent()
    }

    transport.on(Events.PluginStatusChanged, onStatus)
    transport.on(Events.PluginInstalled, onMetadataChanged)
    transport.on(Events.PluginUninstalled, onMetadataChanged)
    transport.on(Events.LocaleChanged, onMetadataChanged)

    return () => {
      mountedRef.current = false
      requestVersionRef.current += 1
      inFlightRef.current = null
      dirtyRef.current = false
      transport.off(Events.PluginStatusChanged, onStatus)
      transport.off(Events.PluginInstalled, onMetadataChanged)
      transport.off(Events.PluginUninstalled, onMetadataChanged)
      transport.off(Events.LocaleChanged, onMetadataChanged)
    }
  }, [refresh])

  return { ...state, refresh }
}
