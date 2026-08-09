import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { PluginCommandGraphDTO } from '@shared/types/plugin-command-graph'
import { useCallback, useEffect, useRef, useState } from 'react'

export type PluginGraphStatus = 'idle' | 'loading' | 'success' | 'error'

export interface PluginGraphError {
  code: string
  message: string
}

export interface PluginGraphState {
  data: PluginCommandGraphDTO | null
  status: PluginGraphStatus
  error: PluginGraphError | null
  isRefreshing: boolean
  refresh(): Promise<void>
}

const POLL_INTERVAL_MS = 5 * 60 * 1000
const GRAPH_LOAD_ERROR_CODE = 'PLUGIN_GRAPH_LOAD_FAILED'
const GRAPH_LOAD_ERROR_MESSAGE = 'Plugin command graph request failed'

function normalizeGraphError(error: unknown): PluginGraphError {
  if (error instanceof Error) {
    return {
      code: GRAPH_LOAD_ERROR_CODE,
      message: error.message || GRAPH_LOAD_ERROR_MESSAGE,
    }
  }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown }
    return {
      code: typeof value.code === 'string' ? value.code : GRAPH_LOAD_ERROR_CODE,
      message:
        typeof value.message === 'string'
          ? value.message
          : GRAPH_LOAD_ERROR_MESSAGE,
    }
  }
  return {
    code: GRAPH_LOAD_ERROR_CODE,
    message: GRAPH_LOAD_ERROR_MESSAGE,
  }
}

export function usePluginGraph(): PluginGraphState {
  const [state, setState] = useState<Omit<PluginGraphState, 'refresh'>>({
    data: null,
    status: 'idle',
    error: null,
    isRefreshing: false,
  })
  const mountedRef = useRef(false)
  const dataRef = useRef<PluginCommandGraphDTO | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const requestVersionRef = useRef(0)

  const refresh = useCallback((): Promise<void> => {
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
      .invoke(Queries.GetPluginCommandGraph)
      .then((response) => {
        if (
          !mountedRef.current ||
          requestVersionRef.current !== requestVersion
        ) {
          return
        }
        const data = response as PluginCommandGraphDTO
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
          error: normalizeGraphError(error),
          isRefreshing: false,
        }))
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null
      })
    inFlightRef.current = request
    return request
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()

    let pollTimer: number | null = null
    const stopPolling = () => {
      if (pollTimer === null) return
      window.clearInterval(pollTimer)
      pollTimer = null
    }
    const startPolling = () => {
      stopPolling()
      if (document.visibilityState !== 'visible') return
      pollTimer = window.setInterval(() => {
        if (document.visibilityState !== 'visible') {
          stopPolling()
          return
        }
        void refresh()
      }, POLL_INTERVAL_MS)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        stopPolling()
        return
      }
      void refresh()
      startPolling()
    }
    startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      mountedRef.current = false
      requestVersionRef.current += 1
      inFlightRef.current = null
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  return { ...state, refresh }
}
