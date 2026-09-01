import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getCACertificates } from 'node:tls'
import { getLogger } from '@core/logger'
import writeFileAtomic from 'write-file-atomic'

const log = getLogger('aria2')

const CA_BUNDLE_FILENAME = 'aria2-ca-bundle.pem'
const PROXY_ENVIRONMENT_KEYS = new Set([
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'all_proxy',
  'no_proxy',
])
const WINDOWS_OPENSSL_OVERRIDE_KEYS = new Set([
  'openssl_conf',
  'openssl_conf_include',
  'openssl_engines',
  'openssl_modules',
  'openssl_ia32cap',
])

type Aria2CertificateSource = 'system' | 'bundled'

export interface Aria2TrustStoreOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  getCertificates?: (source: Aria2CertificateSource) => string[]
}

function normalizeCertificates(certificates: string[]): string[] {
  return [
    ...new Set(
      certificates.map((certificate) => certificate.trim()).filter(Boolean)
    ),
  ]
}

function withoutProxyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !PROXY_ENVIRONMENT_KEYS.has(key.toLowerCase())
    )
  )
}

function withoutWindowsOpenSSLOverrides(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !WINDOWS_OPENSSL_OVERRIDE_KEYS.has(key.toLowerCase())
    )
  )
}

export class Aria2TrustStore {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly getCertificates: (source: Aria2CertificateSource) => string[]
  private readonly bundlePath: string

  constructor(
    private readonly userConfigDir: string,
    options: Aria2TrustStoreOptions = {}
  ) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.getCertificates = options.getCertificates ?? getCACertificates
    this.bundlePath = path.join(userConfigDir, CA_BUNDLE_FILENAME)
  }

  async prepareEnvironment(): Promise<NodeJS.ProcessEnv> {
    // Motrix's applied proxy policy must be the only source of aria2 routing.
    // aria2 otherwise imports protocol-specific proxy environment variables,
    // which can override both all-proxy and the metadata client's route.
    let childEnvironment = withoutProxyEnvironment(this.env)
    if (this.platform === 'win32') {
      // The bundled Windows engine statically links OpenSSL and its providers.
      // Do not let a machine-wide OpenSSL installation replace its config,
      // provider path, or CPU dispatch.  These overrides also affect aria2's
      // WebSocket SHA-1 and RPC-secret HMAC, so inheriting them can break local
      // RPC even when no HTTPS request is made.
      childEnvironment = withoutWindowsOpenSSLOverrides(childEnvironment)
    }
    if (this.platform !== 'linux') return childEnvironment

    if (this.env.SSL_CERT_FILE?.trim() || this.env.SSL_CERT_DIR?.trim()) {
      log.info('using caller-provided OpenSSL trust store for aria2')
      return childEnvironment
    }

    let certificates: string[] = []
    try {
      certificates = normalizeCertificates(this.getCertificates('system'))
    } catch (err) {
      log.warn({ err }, 'failed to read the Linux system CA trust store')
    }

    let source = 'system'
    if (certificates.length === 0) {
      certificates = normalizeCertificates(this.getCertificates('bundled'))
      source = 'bundled-fallback'
      log.warn('Linux system CA trust store is empty; using bundled roots')
    }

    if (certificates.length === 0) {
      throw new Error('No CA certificates are available for aria2 HTTPS')
    }

    await mkdir(this.userConfigDir, { recursive: true })
    await writeFileAtomic(this.bundlePath, `${certificates.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })

    log.info(
      { source, certificateCount: certificates.length, path: this.bundlePath },
      'prepared aria2 CA trust store'
    )

    return {
      ...childEnvironment,
      SSL_CERT_FILE: this.bundlePath,
    }
  }
}
