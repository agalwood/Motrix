import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ConnectionState,
  ServerIdentity,
} from '@/background/ConnectionManager'
import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
  type MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import { send } from '@/background/MessageBus'
import type {
  RemoteBackendPolicyReplacement,
  RemoteBackendPolicyV1,
} from '@/background/RemoteBackendPolicyStore'
import { assertMessageSucceeded } from '@/options/integration/messages'
import type { ServerFormValues } from '@/options/tabs/schemas'
import { normalizeRemoteEndpoint } from '@/shared/endpoint'

/** Keeps catalog mutations, connection refreshes and recovery in one place. */
export function useIntegrationSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<EndpointConfig | null>(null)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected')
  const [serverIdentity, setServerIdentity] = useState<ServerIdentity | null>(
    null
  )
  const [pairing, setPairing] = useState<{
    endpointId: string
    paired: boolean
  } | null>(null)
  const [pairingLoading, setPairingLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [remotePolicyBusy, setRemotePolicyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingServer, setEditingServer] =
    useState<MotrixServerEndpoint | null>(null)
  const [serverToDelete, setServerToDelete] =
    useState<MotrixServerEndpoint | null>(null)
  const [remotePolicy, setRemotePolicy] =
    useState<RemoteBackendPolicyV1 | null>(null)

  const refreshConnection = useCallback(async (): Promise<void> => {
    const response = await send('bg.getState', undefined)
    assertMessageSucceeded(response)
    setConnectionState(response.state)
    setServerIdentity(response.server ?? null)
  }, [])

  const refreshPairing = useCallback(
    async (endpointId: string): Promise<void> => {
      setPairingLoading(true)
      try {
        const response = await send('bg.getPairingStatus', { endpointId })
        assertMessageSucceeded(response)
        setPairing({ endpointId, paired: response.paired })
      } finally {
        setPairingLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [endpointConfig, stateResponse] = await Promise.all([
          send('bg.getEndpointConfig', undefined),
          send('bg.getState', undefined),
        ])
        if (cancelled) return
        assertMessageSucceeded(endpointConfig)
        assertMessageSucceeded(stateResponse)
        setConfig(endpointConfig)
        setConnectionState(stateResponse.state)
        setServerIdentity(stateResponse.server ?? null)
        const pairingResponse = await send('bg.getPairingStatus', {
          endpointId: endpointConfig.activeEndpointId,
        })
        if (cancelled) return
        assertMessageSucceeded(pairingResponse)
        setPairing({
          endpointId: endpointConfig.activeEndpointId,
          paired: pairingResponse.paired,
        })
        setPairingLoading(false)
      } catch (cause) {
        if (!cancelled) {
          setError((cause as Error).message)
          setPairingLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const activeEndpointId = config?.activeEndpointId ?? LOCAL_ENDPOINT_ID
  const activeEndpointIdRef = useRef(activeEndpointId)
  activeEndpointIdRef.current = activeEndpointId
  const activeServer =
    config?.servers.find((server) => server.id === activeEndpointId) ?? null
  const paired =
    pairing?.endpointId === activeEndpointId ? pairing.paired : false
  const isRemote = activeEndpointId !== LOCAL_ENDPOINT_ID

  useEffect(() => {
    if (
      connectionState === 'connected' ||
      connectionState === 'disconnected' ||
      connectionState === 'denied'
    ) {
      return
    }

    let cancelled = false
    let inFlight = false
    const syncingEndpointId = activeEndpointId
    const syncConnection = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const response = await send('bg.getState', undefined)
        assertMessageSucceeded(response)
        if (cancelled || activeEndpointIdRef.current !== syncingEndpointId) {
          return
        }
        setConnectionState(response.state)
        setServerIdentity(response.server ?? null)
      } catch {
        // A transitional state can briefly outlive the background page. The
        // next tick retries until the connection reaches a terminal state.
      } finally {
        inFlight = false
      }
    }

    void syncConnection()
    const timer = window.setInterval(() => void syncConnection(), 1_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeEndpointId, connectionState])

  useEffect(() => {
    let cancelled = false
    if (!isRemote || !paired) {
      setRemotePolicy(null)
      return () => {
        cancelled = true
      }
    }
    if (connectionState !== 'connected') {
      return () => {
        cancelled = true
      }
    }
    void send('bg.getRemoteBackendPolicy', undefined)
      .then((response) => {
        if (cancelled) return
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
      })
      .catch(() => {
        if (!cancelled) setRemotePolicy(null)
      })
    return () => {
      cancelled = true
    }
  }, [connectionState, isRemote, paired])

  const runAction = async (
    action: () => Promise<void>,
    rethrow = false,
    setPending: React.Dispatch<React.SetStateAction<boolean>> = setBusy
  ): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError((cause as Error).message)
      try {
        const latest = await send('bg.getEndpointConfig', undefined)
        assertMessageSucceeded(latest)
        setConfig(latest)
        setPairing(null)
        await Promise.all([
          refreshPairing(latest.activeEndpointId),
          refreshConnection(),
        ])
      } catch {
        // Preserve the original operation error. A subsequent user action or
        // page reload will retry the catalogue read if this refresh also fails.
      }
      if (rethrow) throw cause
    } finally {
      setPending(false)
    }
  }

  const handleEndpointChange = async (
    endpointId: string,
    rethrow = false
  ): Promise<void> => {
    if (config === null || endpointId === config.activeEndpointId) return
    await runAction(async () => {
      const activated = await send('bg.activateEndpoint', { endpointId })
      assertMessageSucceeded(activated)
      setConfig(activated.config)
      setPairing(null)
      setRemotePolicy(null)
      setConnectionState('bootstrapping')
      setServerIdentity(null)
      await Promise.all([
        refreshPairing(activated.config.activeEndpointId),
        refreshConnection(),
      ])
    }, rethrow)
  }

  const handleReconnect = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.reconnect', undefined)
      assertMessageSucceeded(response)
      await Promise.all([refreshPairing(activeEndpointId), refreshConnection()])
    })
  }

  const handleForget = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.unpair', {
        endpointId: activeEndpointId,
      })
      assertMessageSucceeded(response)
      await Promise.all([refreshPairing(activeEndpointId), refreshConnection()])
    })
  }

  const replaceRemotePolicy = async (
    replacement: RemoteBackendPolicyReplacement
  ): Promise<void> => {
    await runAction(
      async () => {
        const response = await send(
          'bg.replaceRemoteBackendPolicy',
          replacement
        )
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
        // replaceRemoteBackendPolicy acknowledges only after its one
        // renegotiation attempt reaches a terminal state. Read that state
        // instead of leaving the page on a synthetic `bootstrapping` snapshot.
        await refreshConnection()
      },
      false,
      setRemotePolicyBusy
    )
  }

  const openAddServer = (): void => {
    setEditingServer(null)
    setEditorOpen(true)
  }

  const openEditServer = (server: MotrixServerEndpoint): void => {
    setEditingServer(server)
    setEditorOpen(true)
  }

  const handleSaveServer = async (
    values: ServerFormValues,
    pairAfterSave = false
  ): Promise<void> => {
    if (config === null) return
    await runAction(async () => {
      const normalizedUrl = normalizeRemoteEndpoint(values.url)
      const duplicate = config.servers.some(
        (server) =>
          server.id !== editingServer?.id && server.url === normalizedUrl
      )
      if (duplicate) throw new Error(t('options.servers.urlDuplicate'))

      const name = values.name.trim()
      const result =
        editingServer === null
          ? await send('bg.addServer', { name, url: normalizedUrl })
          : await send('bg.updateServer', {
              endpointId: editingServer.id,
              expected: {
                name: editingServer.name,
                url: editingServer.url,
                revision: editingServer.revision,
              },
              changes: { name, url: normalizedUrl },
            })
      assertMessageSucceeded(result)
      if (pairAfterSave) setEditingServer(result.server)
      const nextConfig = pairAfterSave
        ? (
            await send('bg.activateEndpoint', {
              endpointId: result.server.id,
            })
          ).config
        : result.config
      setConfig(nextConfig)
      setPairing(null)
      await Promise.all([
        refreshPairing(nextConfig.activeEndpointId),
        refreshConnection(),
      ])
    }, true)
  }

  const handleDeleteServer = async (): Promise<void> => {
    if (config === null || serverToDelete === null) return
    const deleting = serverToDelete
    await runAction(async () => {
      const removed = await send('bg.removeServer', {
        endpointId: deleting.id,
        expected: {
          name: deleting.name,
          url: deleting.url,
          revision: deleting.revision,
        },
      })
      assertMessageSucceeded(removed)
      setConfig(removed.config)
      setServerToDelete(null)
      if (removed.wasActive) {
        setPairing(null)
        setConnectionState('disconnected')
        await Promise.all([
          refreshPairing(removed.config.activeEndpointId),
          refreshConnection(),
        ])
      }
    })
  }

  const refreshAfterPairing = (): void => {
    void Promise.all([refreshPairing(activeEndpointId), refreshConnection()])
  }

  return {
    config,
    connectionState,
    serverIdentity,
    activeEndpointId,
    activeServer,
    isRemote,
    paired,
    pairingLoading,
    busy,
    remotePolicyBusy,
    remotePolicy,
    error,
    editorOpen,
    setEditorOpen,
    editingServer,
    serverToDelete,
    setServerToDelete,
    openAddServer,
    openEditServer,
    handleEndpointChange,
    handleReconnect,
    handleForget,
    replaceRemotePolicy,
    handleSaveServer,
    handleDeleteServer,
    refreshAfterPairing,
  }
}
