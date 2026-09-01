import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Aria2TrustStore } from './aria2-trust-store'

const SYSTEM_CERTIFICATE = `-----BEGIN CERTIFICATE-----
system
-----END CERTIFICATE-----`
const BUNDLED_CERTIFICATE = `-----BEGIN CERTIFICATE-----
bundled
-----END CERTIFICATE-----`

describe('Aria2TrustStore', () => {
  let userConfigDir: string

  beforeEach(async () => {
    userConfigDir = await mkdtemp(path.join(tmpdir(), 'motrix-aria2-ca-'))
  })

  afterEach(async () => {
    await rm(userConfigDir, { recursive: true, force: true })
  })

  it('preserves non-proxy environment values outside Linux', async () => {
    const getCertificates = vi.fn()
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      getCertificates,
    })

    await expect(trustStore.prepareEnvironment()).resolves.toEqual({
      PATH: '/usr/bin',
    })
    expect(getCertificates).not.toHaveBeenCalled()
  })

  it('removes every proxy environment spelling before spawning aria2', async () => {
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows',
        http_proxy: 'http://user:secret@proxy.example:8080',
        HTTPS_PROXY: 'http://proxy.example:8443',
        Ftp_Proxy: 'http://proxy.example:2121',
        ALL_PROXY: 'http://proxy.example:3128',
        No_PrOxY: 'localhost,.internal',
      },
    })

    await expect(trustStore.prepareEnvironment()).resolves.toEqual({
      PATH: 'C:\\Windows',
    })
  })

  it('removes external OpenSSL overrides from the bundled Windows engine', async () => {
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows',
        OPENSSL_CONF: 'C:\\OpenSSL\\openssl.cnf',
        OpenSSL_Conf_Include: 'C:\\OpenSSL\\includes',
        OPENSSL_ENGINES: 'C:\\OpenSSL\\engines',
        OPENSSL_MODULES: 'C:\\OpenSSL\\modules',
        OPENSSL_ia32cap: '~0x200000200000000',
        SSL_CERT_FILE: 'C:\\custom\\roots.pem',
      },
    })

    await expect(trustStore.prepareEnvironment()).resolves.toEqual({
      PATH: 'C:\\Windows',
      // Trust overrides are separate from provider/config overrides and stay
      // available for explicit caller policy.
      SSL_CERT_FILE: 'C:\\custom\\roots.pem',
    })
  })

  it('preserves OpenSSL overrides for a system aria2 outside Windows', async () => {
    const env = {
      PATH: '/usr/bin',
      OPENSSL_CONF: '/etc/ssl/custom.cnf',
    }
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'darwin',
      env,
    })

    await expect(trustStore.prepareEnvironment()).resolves.toEqual(env)
  })

  it.each(['SSL_CERT_FILE', 'SSL_CERT_DIR'] as const)(
    'preserves a caller-provided %s',
    async (variable) => {
      const env = { PATH: '/usr/bin', [variable]: '/custom/trust' }
      const getCertificates = vi.fn()
      const trustStore = new Aria2TrustStore(userConfigDir, {
        platform: 'linux',
        env,
        getCertificates,
      })

      await expect(trustStore.prepareEnvironment()).resolves.toEqual(env)
      expect(getCertificates).not.toHaveBeenCalled()
    }
  )

  it('writes deduplicated system certificates for the aria2 child', async () => {
    const getCertificates = vi.fn((type: string) => {
      expect(type).toBe('system')
      return [SYSTEM_CERTIFICATE, ` ${SYSTEM_CERTIFICATE} `]
    })
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      getCertificates,
    })

    const env = await trustStore.prepareEnvironment()
    const bundlePath = path.join(userConfigDir, 'aria2-ca-bundle.pem')

    expect(env).toEqual({
      PATH: '/usr/bin',
      SSL_CERT_FILE: bundlePath,
    })
    expect(await readFile(bundlePath, 'utf8')).toBe(`${SYSTEM_CERTIFICATE}\n`)
    expect((await stat(bundlePath)).mode & 0o777).toBe(0o600)
  })

  it('falls back to bundled roots when the system store is empty', async () => {
    const getCertificates = vi.fn((type: string) =>
      type === 'system' ? [] : [BUNDLED_CERTIFICATE]
    )
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'linux',
      env: {},
      getCertificates,
    })

    const env = await trustStore.prepareEnvironment()

    expect(getCertificates).toHaveBeenNthCalledWith(1, 'system')
    expect(getCertificates).toHaveBeenNthCalledWith(2, 'bundled')
    expect(await readFile(env?.SSL_CERT_FILE ?? '', 'utf8')).toBe(
      `${BUNDLED_CERTIFICATE}\n`
    )
  })

  it('falls back to bundled roots when reading the system store fails', async () => {
    const getCertificates = vi.fn((type: string) => {
      if (type === 'system') throw new Error('system store unavailable')
      return [BUNDLED_CERTIFICATE]
    })
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'linux',
      env: {},
      getCertificates,
    })

    const env = await trustStore.prepareEnvironment()

    expect(await readFile(env?.SSL_CERT_FILE ?? '', 'utf8')).toBe(
      `${BUNDLED_CERTIFICATE}\n`
    )
  })

  it('fails safely when no trust anchors are available', async () => {
    const trustStore = new Aria2TrustStore(userConfigDir, {
      platform: 'linux',
      env: {},
      getCertificates: vi.fn(() => []),
    })

    await expect(trustStore.prepareEnvironment()).rejects.toThrow(
      'No CA certificates are available for aria2 HTTPS'
    )
  })
})
