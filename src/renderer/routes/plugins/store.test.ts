import { beforeEach, describe, expect, it } from 'vitest'
import { usePluginsStore } from './store'

describe('usePluginsStore', () => {
  beforeEach(() => {
    usePluginsStore.setState({ list: [], detail: {} })
  })

  it('updates enabled state from plugin status events', () => {
    usePluginsStore.getState().setList([
      {
        id: 'plugin.demo',
        name: 'Demo',
        version: '1.0.0',
        description: 'Demo plugin',
        status: 'inactive',
        enabled: true,
        permissions: [],
        optionalPermissions: [],
        errorCount: 0,
      },
    ])

    const applyStatus = usePluginsStore.getState().applyStatus as (
      id: string,
      status: 'disabled',
      lastError?: string,
      enabled?: boolean
    ) => void
    applyStatus('plugin.demo', 'disabled', undefined, false)

    expect(usePluginsStore.getState().list[0]).toMatchObject({
      status: 'disabled',
      enabled: false,
    })
  })

  it('clearUpdate removes only the named plugin from the updates map', () => {
    usePluginsStore.setState({
      updates: {
        'plugin.a': { latestVersion: '1.1.0', channel: 'builtin' },
        'plugin.b': { latestVersion: '2.0.0', channel: 'community' },
      },
    })

    usePluginsStore.getState().clearUpdate('plugin.a')

    expect(usePluginsStore.getState().updates).toEqual({
      'plugin.b': { latestVersion: '2.0.0', channel: 'community' },
    })
  })

  it('clearUpdate is a no-op when the pluginId is not present', () => {
    const initial = {
      'plugin.b': { latestVersion: '2.0.0', channel: 'community' as const },
    }
    usePluginsStore.setState({ updates: initial })

    usePluginsStore.getState().clearUpdate('plugin.missing')

    expect(usePluginsStore.getState().updates).toEqual(initial)
  })
})
