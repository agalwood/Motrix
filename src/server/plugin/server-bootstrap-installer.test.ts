import { describe, expect, it, vi } from 'vitest'
import { serverBootstrapInstall } from './server-bootstrap-installer'

const consent = {
  trustSurface: {
    optionalPermissions: [{ name: 'notify' }, { name: 'ffmpeg' }],
  },
}

describe('serverBootstrapInstall', () => {
  it('returns an empty result when no declarative sources are configured', async () => {
    const service = { stage: vi.fn() }
    const installer = { commit: vi.fn() }
    await expect(
      serverBootstrapInstall(service as never, installer as never, {})
    ).resolves.toEqual({ accepted: [], rejected: [] })
  })

  it('routes GitHub, registry, and URL sources through the install service', async () => {
    const service = {
      stage: vi
        .fn()
        .mockResolvedValueOnce({
          stagingId: 's1',
          consent,
          committed: false,
        })
        .mockResolvedValueOnce({
          stagingId: 's2',
          consent,
          committed: true,
          pluginId: 'registry.plugin',
        })
        .mockResolvedValueOnce({
          stagingId: 's3',
          consent,
          committed: false,
        }),
    }
    const installer = {
      commit: vi
        .fn()
        .mockResolvedValueOnce({ pluginId: 'github.plugin' })
        .mockResolvedValueOnce({ pluginId: 'url.plugin' }),
    }

    const result = await serverBootstrapInstall(
      service as never,
      installer as never,
      {
        MOTRIX_PLUGIN_INSTALL_URLS:
          'github:acme/widget,registry:acme.registry,https://example.com/widget.moext',
      }
    )

    expect(service.stage).toHaveBeenNthCalledWith(1, {
      sourceType: 'github',
      spec: 'acme/widget',
    })
    expect(service.stage).toHaveBeenNthCalledWith(2, {
      sourceType: 'registry',
      pluginId: 'acme.registry',
    })
    expect(service.stage).toHaveBeenNthCalledWith(3, {
      sourceType: 'url',
      url: 'https://example.com/widget.moext',
    })
    expect(installer.commit).toHaveBeenNthCalledWith(1, 's1', {
      notify: 'denied',
      ffmpeg: 'denied',
    })
    expect(installer.commit).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      accepted: ['github.plugin', 'registry.plugin', 'url.plugin'],
      rejected: [],
    })
  })

  it('reports every rejected source without hiding successful installs', async () => {
    const service = {
      stage: vi
        .fn()
        .mockRejectedValueOnce(new Error('download failed'))
        .mockResolvedValueOnce({
          stagingId: 's2',
          consent,
          committed: false,
        }),
    }
    const installer = {
      commit: vi.fn().mockResolvedValue({ pluginId: 'good.plugin' }),
    }

    await expect(
      serverBootstrapInstall(service as never, installer as never, {
        MOTRIX_PLUGIN_INSTALL_URLS:
          '["https://bad.example/a.moext","https://good.example/b.moext"]',
      })
    ).resolves.toEqual({
      accepted: ['good.plugin'],
      rejected: [
        {
          source: 'https://bad.example/a.moext',
          reason: 'download failed',
        },
      ],
    })
  })
})
