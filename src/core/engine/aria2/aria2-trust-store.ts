import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getCACertificates } from 'node:tls'
import { getLogger } from '@core/logger'
import writeFileAtomic from 'write-file-atomic'

const log = getLogger('aria2')

const CA_BUNDLE_FILENAME = 'aria2-ca-bundle.pem'

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

  async prepareEnvironment(): Promise<NodeJS.ProcessEnv | undefined> {
    if (this.platform !== 'linux') return undefined

    if (this.env.SSL_CERT_FILE?.trim() || this.env.SSL_CERT_DIR?.trim()) {
      log.info('using caller-provided OpenSSL trust store for aria2')
      return this.env
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
      ...this.env,
      SSL_CERT_FILE: this.bundlePath,
    }
  }
}
