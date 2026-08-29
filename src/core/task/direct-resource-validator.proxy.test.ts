// @vitest-environment node

import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer,
  type Server as HttpServer,
  type IncomingHttpHeaders,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer,
} from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server as ProxyServer } from 'proxy-chain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectResourceValidatorService } from './direct-resource-validator'

const LOOPBACK_HOST = '127.0.0.1'
const REMOTE_FILENAME = 'VSCodeSetup-x64-proxy-test.exe'
const ELECTRON_RUN_TIMEOUT_MS = 15_000
const SOCKS_STALL_TIMEOUT_MS = 150
const REQUIRE_ELECTRON_RUNTIME =
  process.env.MOTRIX_REQUIRE_ELECTRON_PROXY_TEST === '1'
const bundledAria2Path = path.resolve(
  process.cwd(),
  'extra',
  process.platform,
  process.arch,
  'aria2c'
)
const bundledAria2Test = existsSync(bundledAria2Path) ? it : it.skip

// Test-only self-signed certificate for 127.0.0.1. HTTPS verification is
// disabled only in the two child/request scopes that exercise proxy CONNECT.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCzMvQoVep4eh5K
+yQsBf6kaWJOj8Pzpr7aBxnoHR5NJeQBpg3h4J5pBSyoNdLKbFV6vSnt8IMLhlU+
jTPgx9oPPUjNgijiF+Q+3cx+k+NnJKxxO1vWB7IYkvIHuqVuWwA856Ya/ipZb1o4
xK9oQgEXhsAglTCT7SRJJgJ4a7sM+4acKSvb7zoml0mLwvbFoldt6hOw+TYbAtzo
kSP+SqVUyuO8tndn4ZdFHLQ2SEEUT2lJj29XQHU9qbu1TguFMZEcMIjAGiY6f7be
gTpaC1In9iQq7Gdu6ILNMOe8a1NdjrKy/UqxkB4p3YpvvRwf3uCwRWS3BxBW6HuH
j7A+Y/OxAgMBAAECggEAATOkxoZ4+ZDcFiWkAvWRVRnt0lgNeNtT6VNl3ZQgaWUJ
J+esrSib91lVCNW/kaLzWczd9J4JyvB+Ltq0j9vXPwXqsJIgYw/E9JT5M5obSsxI
qcO7pG5Nx/NoUxvx0xEiKcZl60VsFEh2Yu4SvRDAQB+jtzQ47K0I8sKh/pu+V+Jv
D4F7bWCunhaOM0WVvoFPQ6KQPccoJaRL0EvCykpSUZTzwHmJ1BJL/dFxp+BsABCL
g26gomB72qJhbSCY5owx5F5iLKQUy7EU2QYAIHg+v6tuLpdugZq+JtvMQQnTMI74
dkL8rWWpBsmKRL99qfj27SCHYQCflb04T7CtQ1XO5wKBgQDbrq0FAR7q7tVfmavP
oGU/7TsjXbE8EWs9REAmBU5usiz1ZjGzGNUcCWTs3JhLpssh7hGJgYfLqvFh88tS
CRfCxO5x05uRaOEsI1hovj74KlLLNv84ytC+9i+PP940Lp6fjxK0T0aCxqUruZT0
SDkHKbfo/jQXO011wobSBlzyywKBgQDQ0vUOLlX9ze/DBSVqFAYuivomlp3vq44J
5A306hEehMCveQHSzon4G7gVzGQESfWGkd8iHnZqmLMSsFBS4kU8ZH6kc8WuSfkY
NnFAAYP/LGxjt0hIilGSj65G0PcAFqvppiFgR+EYpr/DmqEST9rqEqpQBIuRgac5
qao+B6PX8wKBgEDlOPdhfWCpbR7wpnCPUVmxGuc3pkO4YZWXs9uHdcP9nopfxg7C
JzJBFC9kexjeDOPZEBUuzo670NK+0jFJvlsrEcVOXYZ3FQ2U42kNykxFNHATrxF3
2HKRBzuqAlon63P3L+9T++BmDiT8jaQcMbyL9mg9r+Ws/xTqgilI9+xBAoGANcD3
/8yBqjGmtEbQ2LuK09RGjERdJ2K7z2P7C75s5bQ6fXDivUcZUNqhykqwvEHlh9xo
2bmJterUvczRAGTqeZ9M0jxS+IhmLItnH5jER51B0XFOlA227ck6jVQhIM61NhHj
qYsXMGdMGafmKnaP3Y0sdiiVXMFJMJiyEAGbdW0CgYBCkkVR3Qa3LhqhgHOPW98n
RAMHTNmhgGOEDq1vzT61ApiW3WlQxwwjTfELY6ynqxRSeXKYVude2iRIT78MJtT4
CLjJyy6J2Gj19g1Wj0DWmoxvTsCu9RKi+O02AVXm/HXV3HhIyfO7ggBbF+MLr+tl
oBhOGFOBD2dWzgKDbyy6hw==
-----END PRIVATE KEY-----`

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUF4ztfsfVGCjAspx3wLeWkRvmQ6AwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyOTAxNDEzNFoXDTM2MDgy
NjAxNDEzNFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAszL0KFXqeHoeSvskLAX+pGliTo/D86a+2gcZ6B0eTSXk
AaYN4eCeaQUsqDXSymxVer0p7fCDC4ZVPo0z4MfaDz1IzYIo4hfkPt3MfpPjZySs
cTtb1geyGJLyB7qlblsAPOemGv4qWW9aOMSvaEIBF4bAIJUwk+0kSSYCeGu7DPuG
nCkr2+86JpdJi8L2xaJXbeoTsPk2GwLc6JEj/kqlVMrjvLZ3Z+GXRRy0NkhBFE9p
SY9vV0B1Pam7tU4LhTGRHDCIwBomOn+23oE6WgtSJ/YkKuxnbuiCzTDnvGtTXY6y
sv1KsZAeKd2Kb70cH97gsEVktwcQVuh7h4+wPmPzsQIDAQABo28wbTAdBgNVHQ4E
FgQUvtf3LJ4KQlKUHYglQPJnzriNmXkwHwYDVR0jBBgwFoAUvtf3LJ4KQlKUHYgl
QPJnzriNmXkwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAD91BW2leyuWHz4XVE/kY+KXhyWr189q
76JVkJvXSpe1xxfj05mj5h4tug1ScqoTM9LRN4zfxyO4Sg2VdFx26UnJewFUvMdo
8y2xgNt3E1BZvmFeSVqs4xZBYJN755/K4DGKKyxUNGpMwj2mRTx1+d5+RuEuwQ3h
lXLsEqlkYSRsOePFt1FG7S3lqvvp0FZIhm6OfJSwonFzyLUy4a2N/2UIk75ppjS2
lTv1/xRVw+/pxmhhc+8i/YrbEdtgNk8Q+qBo1HMYXQxiTMm1nNBIWx/A0BNhlSh5
1RW5cFDUfeI1TKinPDbPqqqYkOZQ55kzjk4OrCN+WW4e2+3xayAfOWY=
-----END CERTIFICATE-----`

interface ElectronProbeOutput {
  globalFetchCalls: number
  result: {
    filename: string | null
    validator: {
      kind: string
      value: string
      contentLength?: number
      capturedAt: number
    } | null
  } | null
  runtime: {
    electron: string | null
    embeddedUndici: string | null
    node: string
  }
}

function resolveInstalledElectronPath(): string | null {
  const require = createRequire(import.meta.url)
  const packageDirectory = path.dirname(
    require.resolve('electron/package.json')
  )
  let executableRelativePath: string
  try {
    executableRelativePath = readFileSync(
      path.join(packageDirectory, 'path.txt'),
      'utf8'
    ).trim()
  } catch {
    return null
  }
  if (!executableRelativePath) return null

  const distDirectory =
    process.env.ELECTRON_OVERRIDE_DIST_PATH ??
    path.join(packageDirectory, 'dist')
  const executablePath = path.join(distDirectory, executableRelativePath)
  return existsSync(executablePath) ? executablePath : null
}

const electronPath = resolveInstalledElectronPath()
if (REQUIRE_ELECTRON_RUNTIME && !electronPath) {
  throw new Error(
    'Electron proxy compatibility test requires a hydrated Electron runtime'
  )
}
const electronRuntimeTest = electronPath ? it : it.skip

async function listen(server: TcpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function closeTcpServer(
  server: TcpServer | undefined,
  sockets: ReadonlySet<Socket>
): Promise<void> {
  if (!server?.listening) return
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function closeServer(server: HttpServer | undefined): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}

function runElectronProbe(
  targetUrl: string,
  proxyUrl: string | null,
  allowSelfSignedTls = false
): Promise<ElectronProbeOutput> {
  if (!electronPath) {
    throw new Error('Electron runtime is unavailable')
  }
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'src/core/task/direct-resource-validator.ts')
  ).href
  const script = `
let globalFetchCalls = 0
globalThis.fetch = async () => {
  globalFetchCalls += 1
  throw new Error('embedded global fetch must not receive a package dispatcher')
}
const { DirectResourceValidatorService } = await import(${JSON.stringify(moduleUrl)})
const result = await new DirectResourceValidatorService().probe(
  ${JSON.stringify(targetUrl)},
  ${
    proxyUrl === null
      ? `{ userAgent: 'Motrix/2.0' }`
      : `{ proxy: ${JSON.stringify(proxyUrl)}, noProxy: '', userAgent: 'Motrix/2.0' }`
  },
)
process.stdout.write(JSON.stringify({
  globalFetchCalls,
  result,
  runtime: {
    electron: process.versions.electron ?? null,
    embeddedUndici: process.versions.undici ?? null,
    node: process.versions.node,
  },
}))
`

  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ...(allowSelfSignedTls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
        },
        maxBuffer: 1024 * 1024,
        timeout: ELECTRON_RUN_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Electron proxy probe failed: ${stderr.trim() || error.message}`
            )
          )
          return
        }
        try {
          const line = stdout.trim().split(/\r?\n/u).at(-1)
          if (!line) throw new Error('Electron proxy probe produced no output')
          resolve(JSON.parse(line) as ElectronProbeOutput)
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

describe('DirectResourceValidatorService proxy runtime', () => {
  let origin: HttpServer | undefined
  let originUrl = ''
  let proxy: ProxyServer | undefined
  const originRequests: string[] = []
  const originHeaders: IncomingHttpHeaders[] = []
  const proxyRoutes: Array<{
    hostname: string
    isHttp: boolean
    port: number
  }> = []

  beforeEach(async () => {
    originRequests.length = 0
    originHeaders.length = 0
    proxyRoutes.length = 0
    origin = createServer((request, response) => {
      originRequests.push(`${request.method} ${request.url}`)
      originHeaders.push({ ...request.headers })
      if (request.url === '/stable') {
        response.writeHead(302, { Location: '/artifacts/latest' })
        response.end()
        return
      }
      if (request.url === '/artifacts/latest') {
        response.writeHead(200, {
          'Content-Disposition': `attachment; filename="${REMOTE_FILENAME}"`,
          'Content-Length': '4096',
          ETag: '"proxy-release-v1"',
        })
        response.end(Buffer.alloc(4096))
        return
      }
      if (request.url === '/verify') {
        if (
          request.headers.range === 'bytes=0-0' &&
          request.headers['if-range'] === '"proxy-release-v1"'
        ) {
          response.writeHead(206, {
            'Content-Range': 'bytes 0-0/4096',
            'Content-Length': '1',
            ETag: '"proxy-release-v1"',
          })
          response.end('x')
          return
        }
        response.writeHead(412)
        response.end()
        return
      }
      if (request.url === '/aria2-accept') {
        response.writeHead(200, { 'Content-Length': '1' })
        response.end('x')
        return
      }
      if (request.url === '/cookie-start') {
        response.writeHead(302, {
          Location: '/cookie-final',
          'Set-Cookie': 'variant=cookie; Path=/',
        })
        response.end()
        return
      }
      if (request.url === '/cookie-final') {
        const hasRedirectCookie =
          request.headers.cookie?.includes('variant=cookie') ?? false
        const body = hasRedirectCookie ? 'cookie-variant' : 'baseline-variant'
        response.writeHead(200, {
          'Content-Disposition': `attachment; filename="${body}.bin"`,
          'Content-Length': String(Buffer.byteLength(body)),
          ETag: hasRedirectCookie ? '"cookie-v1"' : '"baseline-v1"',
        })
        response.end(body)
        return
      }
      response.writeHead(404)
      response.end()
    })
    originUrl = `http://${LOOPBACK_HOST}:${await listen(origin)}`

    proxy = new ProxyServer({
      host: LOOPBACK_HOST,
      port: 0,
      prepareRequestFunction: ({ hostname, isHttp, port }) => {
        proxyRoutes.push({ hostname, isHttp, port })
      },
    })
    await proxy.listen()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await proxy?.close(true)
    proxy = undefined
    await closeServer(origin)
    origin = undefined
  })

  it('uses the package fetch with its proxy dispatcher across redirects', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('embedded global fetch must not receive a package dispatcher')
      )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe(`${originUrl}/stable`, {
        proxy: `http://${LOOPBACK_HOST}:${proxy?.port}`,
        noProxy: '',
        userAgent: 'Motrix/2.0',
      })
    ).resolves.toEqual({
      filename: REMOTE_FILENAME,
      validator: {
        kind: 'strong-etag',
        value: '"proxy-release-v1"',
        contentLength: 4096,
        capturedAt: expect.any(Number),
      },
    })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(proxy?.stats.httpRequestCount).toBeGreaterThanOrEqual(2)
    expect(originRequests).toEqual(['GET /stable', 'GET /artifacts/latest'])
    expect(originHeaders[0]).toMatchObject({
      accept: '*/*',
      'accept-encoding': 'deflate, gzip',
      'user-agent': 'Motrix/2.0',
      'want-digest': 'SHA-512;q=1, SHA-256;q=1, SHA;q=0.1',
    })
    expect(originHeaders[0]).not.toHaveProperty('accept-language')
    expect(originHeaders[0]).not.toHaveProperty('sec-fetch-mode')
  })

  it('honors aria2 CIDR bypass without touching the configured proxy', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('embedded global fetch must not receive a package dispatcher')
      )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe(`${originUrl}/stable`, {
        proxy: `http://${LOOPBACK_HOST}:${proxy?.port}`,
        noProxy: '127.0.0.0/8',
      })
    ).resolves.toEqual({
      filename: REMOTE_FILENAME,
      validator: expect.objectContaining({ value: '"proxy-release-v1"' }),
    })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(proxy?.stats.httpRequestCount).toBe(0)
    expect(originRequests).toEqual(['GET /stable', 'GET /artifacts/latest'])
  })

  it('sends an explicitly empty User-Agent without an Undici default', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe(`${originUrl}/stable`, { userAgent: '' })
    ).resolves.toEqual({
      filename: REMOTE_FILENAME,
      validator: expect.objectContaining({ value: '"proxy-release-v1"' }),
    })

    expect(originHeaders[0]).toHaveProperty('user-agent', '')
  })

  bundledAria2Test(
    'pins the bundled aria2 HTTP Accept header to the metadata value',
    async () => {
      const outputDir = mkdtempSync(
        path.join(os.tmpdir(), 'motrix-aria2-accept-')
      )
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bundledAria2Path, [
            `--dir=${outputDir}`,
            '--out=payload',
            '--allow-overwrite=true',
            '--auto-file-renaming=false',
            '--console-log-level=error',
            '--summary-interval=0',
            '--all-proxy=',
            '--http-proxy=',
            '--https-proxy=',
            '--ftp-proxy=',
            '--header=Accept: */*',
            `${originUrl}/aria2-accept`,
          ])
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('bundled aria2 header probe timed out'))
          }, 10_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`bundled aria2 exited with code ${code}`))
          })
        })

        expect(originHeaders.at(-1)?.accept).toBe('*/*')
      } finally {
        rmSync(outputDir, { recursive: true, force: true })
      }
    }
  )

  bundledAria2Test(
    'suppresses redirect CookieStorage with the same empty Cookie field as metadata requests',
    async () => {
      const outputDir = mkdtempSync(
        path.join(os.tmpdir(), 'motrix-aria2-cookie-')
      )
      const runAria2Sequence = async (
        outputPrefix: string,
        headers: readonly string[] = []
      ) => {
        const inputPath = path.join(outputDir, `${outputPrefix}.txt`)
        writeFileSync(
          inputPath,
          [
            `${originUrl}/cookie-start`,
            `  out=${outputPrefix}-first`,
            `${originUrl}/cookie-final`,
            `  out=${outputPrefix}-second`,
            '',
          ].join('\n')
        )
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bundledAria2Path, [
            `--dir=${outputDir}`,
            `--input-file=${inputPath}`,
            '--max-concurrent-downloads=1',
            '--allow-overwrite=true',
            '--auto-file-renaming=false',
            '--console-log-level=error',
            '--summary-interval=0',
            '--all-proxy=',
            '--http-proxy=',
            '--https-proxy=',
            '--ftp-proxy=',
            ...headers.map((header) => `--header=${header}`),
          ])
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('bundled aria2 CookieStorage probe timed out'))
          }, 10_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`bundled aria2 exited with code ${code}`))
          })
        })
        return [
          readFileSync(path.join(outputDir, `${outputPrefix}-first`), 'utf8'),
          readFileSync(path.join(outputDir, `${outputPrefix}-second`), 'utf8'),
        ]
      }

      try {
        const service = new DirectResourceValidatorService()
        await expect(
          service.probe(`${originUrl}/cookie-start`)
        ).resolves.toEqual({
          filename: 'baseline-variant.bin',
          validator: {
            kind: 'strong-etag',
            value: '"baseline-v1"',
            contentLength: Buffer.byteLength('baseline-variant'),
            capturedAt: expect.any(Number),
          },
        })
        expect(originHeaders.at(-1)).toHaveProperty('cookie', '')

        originRequests.length = 0
        originHeaders.length = 0
        await expect(runAria2Sequence('ambient-cookie')).resolves.toEqual([
          'cookie-variant',
          'cookie-variant',
        ])
        expect(originRequests).toEqual([
          'GET /cookie-start',
          'GET /cookie-final',
          'GET /cookie-final',
        ])
        expect(originHeaders.at(-1)?.cookie).toContain('variant=cookie')

        originRequests.length = 0
        originHeaders.length = 0
        await expect(
          runAria2Sequence('pinned-empty-cookie', [
            'Cookie: ',
            'Authorization: ',
            'Accept: */*',
          ])
        ).resolves.toEqual(['baseline-variant', 'baseline-variant'])
        expect(originRequests).toEqual([
          'GET /cookie-start',
          'GET /cookie-final',
          'GET /cookie-final',
        ])
        expect(originHeaders.at(-1)).toMatchObject({
          authorization: '',
          cookie: '',
        })
      } finally {
        rmSync(outputDir, { recursive: true, force: true })
      }
    }
  )

  it('verifies a resumable source through the real proxy dispatcher', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('embedded global fetch must not receive a package dispatcher')
      )
    const service = new DirectResourceValidatorService()

    await expect(
      service.verify(
        `${originUrl}/verify`,
        {
          kind: 'strong-etag',
          value: '"proxy-release-v1"',
          contentLength: 4096,
          capturedAt: 7,
        },
        { proxy: `http://${LOOPBACK_HOST}:${proxy?.port}`, noProxy: '' }
      )
    ).resolves.toEqual({
      outcome: 'unchanged',
      ifRange: '"proxy-release-v1"',
    })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(proxy?.stats.httpRequestCount).toBeGreaterThanOrEqual(1)
    expect(originRequests).toEqual(['GET /verify'])
  })

  it('tears down a SOCKS5 socket stalled before its greeting response', async () => {
    const sockets = new Set<Socket>()
    let acceptedConnections = 0
    const socksServer = createTcpServer((socket) => {
      acceptedConnections += 1
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => undefined)
      // Consume the client's greeting but intentionally never send a reply.
      socket.resume()
    })
    const socksPort = await listen(socksServer)

    try {
      const service = new DirectResourceValidatorService(
        undefined,
        SOCKS_STALL_TIMEOUT_MS
      )

      await expect(
        service.probe(`${originUrl}/stable`, {
          proxy: `socks5://${LOOPBACK_HOST}:${socksPort}`,
        })
      ).resolves.toBeNull()

      expect(acceptedConnections).toBeGreaterThan(0)
      await vi.waitFor(
        () => {
          expect(sockets.size).toBe(0)
        },
        { interval: 10, timeout: 2_000 }
      )
    } finally {
      await closeTcpServer(socksServer, sockets)
    }
  })

  electronRuntimeTest(
    'uses CONNECT for each HTTPS redirect origin in Electron',
    async () => {
      const secureRequests: string[] = []
      const tlsOptions = { cert: TEST_TLS_CERT, key: TEST_TLS_KEY }
      let artifactOrigin: HttpServer | undefined
      let redirectOrigin: HttpServer | undefined

      try {
        artifactOrigin = createHttpsServer(tlsOptions, (request, response) => {
          secureRequests.push(`artifact ${request.method} ${request.url}`)
          if (request.url !== '/artifacts/latest') {
            response.writeHead(404)
            response.end()
            return
          }
          response.writeHead(200, {
            'Content-Disposition': `attachment; filename="${REMOTE_FILENAME}"`,
            'Content-Length': '4096',
            ETag: '"proxy-release-v1"',
          })
          response.end(Buffer.alloc(4096))
        })
        const artifactPort = await listen(artifactOrigin)

        redirectOrigin = createHttpsServer(tlsOptions, (request, response) => {
          secureRequests.push(`redirect ${request.method} ${request.url}`)
          if (request.url !== '/stable') {
            response.writeHead(404)
            response.end()
            return
          }
          response.writeHead(302, {
            Location: `https://${LOOPBACK_HOST}:${artifactPort}/artifacts/latest`,
          })
          response.end()
        })
        const redirectPort = await listen(redirectOrigin)

        const output = await runElectronProbe(
          `https://${LOOPBACK_HOST}:${redirectPort}/stable`,
          `http://${LOOPBACK_HOST}:${proxy?.port}`,
          true
        )

        expect(output.result).toEqual({
          filename: REMOTE_FILENAME,
          validator: {
            kind: 'strong-etag',
            value: '"proxy-release-v1"',
            contentLength: 4096,
            capturedAt: expect.any(Number),
          },
        })
        expect(output.globalFetchCalls).toBe(0)
        expect(output.runtime.electron).toBeTruthy()
        expect(proxy?.stats.httpRequestCount).toBe(0)
        expect(proxy?.stats.connectRequestCount).toBe(2)
        expect(proxyRoutes).toEqual([
          { hostname: LOOPBACK_HOST, isHttp: false, port: redirectPort },
          { hostname: LOOPBACK_HOST, isHttp: false, port: artifactPort },
        ])
        expect(secureRequests).toEqual([
          'redirect GET /stable',
          'artifact GET /artifacts/latest',
        ])
      } finally {
        await closeServer(redirectOrigin)
        await closeServer(artifactOrigin)
      }
    }
  )

  electronRuntimeTest(
    'uses package-owned fetch and dispatcher without a configured proxy in Electron',
    async () => {
      const output = await runElectronProbe(`${originUrl}/stable`, null)

      expect(output.result).toEqual({
        filename: REMOTE_FILENAME,
        validator: {
          kind: 'strong-etag',
          value: '"proxy-release-v1"',
          contentLength: 4096,
          capturedAt: expect.any(Number),
        },
      })
      expect(output.globalFetchCalls).toBe(0)
      expect(output.runtime.electron).toBeTruthy()
      expect(proxy?.stats.httpRequestCount).toBe(0)
      expect(proxy?.stats.connectRequestCount).toBe(0)
      expect(originRequests).toEqual(['GET /stable', 'GET /artifacts/latest'])
      expect(originHeaders[0]).not.toHaveProperty('accept-language')
      expect(originHeaders[0]).not.toHaveProperty('sec-fetch-mode')
    }
  )

  electronRuntimeTest(
    'uses the package fetch with its proxy dispatcher in Electron',
    async () => {
      const output = await runElectronProbe(
        `${originUrl}/stable`,
        `http://${LOOPBACK_HOST}:${proxy?.port}`
      )

      expect(output.result).toEqual({
        filename: REMOTE_FILENAME,
        validator: {
          kind: 'strong-etag',
          value: '"proxy-release-v1"',
          contentLength: 4096,
          capturedAt: expect.any(Number),
        },
      })
      expect(output.globalFetchCalls).toBe(0)
      expect(output.runtime.electron).toBeTruthy()
      expect(output.runtime.embeddedUndici).toBeTruthy()
      expect(output.runtime.node).toBeTruthy()
      expect(proxy?.stats.httpRequestCount).toBeGreaterThanOrEqual(2)
      expect(originRequests).toEqual(['GET /stable', 'GET /artifacts/latest'])
    }
  )
})
