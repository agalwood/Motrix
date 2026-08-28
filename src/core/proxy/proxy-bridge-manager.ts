import { randomBytes } from 'node:crypto'
import { getLogger } from '@core/logger'
import type { ProxySettings } from '@shared/types/settings'
import { Server } from 'proxy-chain'
import {
  type Aria2ProxyOptions,
  proxyToAria2Options,
  proxyToFetchUrl,
  proxyToUrl,
} from './serializers'

const LOOPBACK_HOST = '127.0.0.1'

export interface LocalProxyServer {
  port: number
  listen(): Promise<void>
  close(destroyConnections?: boolean): Promise<unknown>
}

export type LocalProxyServerFactory = (
  getUpstreamProxyUrl: () => string,
  isAuthorized: (username: string, password: string) => boolean
) => LocalProxyServer

export interface LocalProxyCredentials {
  username: string
  password: string
}

export type LocalProxyCredentialsFactory = () => LocalProxyCredentials

export interface ProxyBridgeResolver {
  resolveForDownload(settings: ProxySettings): Promise<Aria2ProxyOptions | null>
  resolveForFetch(settings: ProxySettings): Promise<string | null>
  reconcile(settings: ProxySettings): Promise<void>
}

function createLocalProxyServer(
  getUpstreamProxyUrl: () => string,
  isAuthorized: (username: string, password: string) => boolean
): LocalProxyServer {
  return new Server({
    host: LOOPBACK_HOST,
    port: 0,
    prepareRequestFunction: ({ username, password }) =>
      isAuthorized(username, password)
        ? { upstreamProxyUrl: getUpstreamProxyUrl() }
        : { requestAuthentication: true },
  })
}

function createLocalProxyCredentials(): LocalProxyCredentials {
  return {
    username: randomBytes(24).toString('base64url'),
    password: randomBytes(24).toString('base64url'),
  }
}

export class ProxyBridgeManager implements ProxyBridgeResolver {
  private readonly log = getLogger('proxy-bridge')
  private server: LocalProxyServer | null = null
  private socks5ProxyUrl = ''
  private localProxyUsername = ''
  private localProxyPassword = ''
  private lifecycle: Promise<void> = Promise.resolve()

  constructor(
    private readonly createServer: LocalProxyServerFactory = createLocalProxyServer,
    private readonly createCredentials: LocalProxyCredentialsFactory = createLocalProxyCredentials
  ) {}

  async resolveForDownload(
    settings: ProxySettings
  ): Promise<Aria2ProxyOptions | null> {
    return this.runExclusive(async () => {
      await this.reconcileLocked(settings)
      if (settings.protocol !== 'socks5') {
        return proxyToAria2Options(settings)
      }
      if (!this.isUsable(settings, 'download')) return null

      const localProxyUrl = await this.resolveSocks5Locked(settings)
      return {
        allProxy: localProxyUrl,
        noProxy: settings.bypass.join(','),
      }
    })
  }

  async resolveForFetch(settings: ProxySettings): Promise<string | null> {
    return this.runExclusive(async () => {
      await this.reconcileLocked(settings)
      if (settings.protocol !== 'socks5') {
        return proxyToFetchUrl(settings)
      }
      if (!this.isUsable(settings, 'updateTrackers')) return null
      return this.resolveSocks5Locked(settings)
    })
  }

  async reconcile(settings: ProxySettings): Promise<void> {
    await this.runExclusive(() => this.reconcileLocked(settings))
  }

  async close(): Promise<void> {
    await this.runExclusive(() => this.stopLocked())
  }

  private isUsable(
    settings: ProxySettings,
    scope: keyof ProxySettings['scopes']
  ): boolean {
    return (
      settings.enabled &&
      settings.scopes[scope] &&
      settings.host.length > 0 &&
      settings.port > 0
    )
  }

  private needsBridge(settings: ProxySettings): boolean {
    return (
      settings.protocol === 'socks5' &&
      (this.isUsable(settings, 'download') ||
        this.isUsable(settings, 'updateTrackers'))
    )
  }

  private async reconcileLocked(settings: ProxySettings): Promise<void> {
    if (!this.needsBridge(settings)) {
      await this.stopLocked()
      return
    }

    // Keep an existing listener stable while atomically switching new
    // connections to the latest SOCKS5 upstream.
    this.socks5ProxyUrl = proxyToUrl(settings)
  }

  private async resolveSocks5Locked(settings: ProxySettings): Promise<string> {
    // The callback passed to proxy-chain reads this value for every new
    // request. Updating it keeps the loopback endpoint stable while new
    // connections atomically switch to the latest SOCKS5 upstream.
    this.socks5ProxyUrl = proxyToUrl(settings)
    const server = await this.ensureServerLocked()
    const username = encodeURIComponent(this.localProxyUsername)
    const password = encodeURIComponent(this.localProxyPassword)
    return `http://${username}:${password}@${LOOPBACK_HOST}:${server.port}`
  }

  private async ensureServerLocked(): Promise<LocalProxyServer> {
    if (this.server) return this.server

    const credentials = this.createCredentials()
    this.localProxyUsername = credentials.username
    this.localProxyPassword = credentials.password
    const server = this.createServer(
      () => this.socks5ProxyUrl,
      (username, password) =>
        username.length > 0 &&
        username === this.localProxyUsername &&
        password === this.localProxyPassword
    )

    try {
      await server.listen()
      this.server = server
      this.log.info(
        { host: LOOPBACK_HOST, port: server.port },
        'local SOCKS5 bridge started'
      )
      return server
    } catch (error) {
      this.clearSensitiveState()
      throw error
    }
  }

  private async stopLocked(): Promise<void> {
    const server = this.server
    this.server = null
    // Revoke loopback authentication and remove the upstream URL before
    // waiting for active connections to close.
    this.clearSensitiveState()
    if (!server) return

    await server.close(true)
    this.log.info('local SOCKS5 bridge stopped')
  }

  private clearSensitiveState(): void {
    this.socks5ProxyUrl = ''
    this.localProxyUsername = ''
    this.localProxyPassword = ''
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
