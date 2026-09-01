import { describe, expect, it, vi } from 'vitest'
import { OperatorAdminExitCode, runOperatorAdmin } from './operator-admin'

const TOKEN = 't'.repeat(43)
const REQUEST_ID = 'r'.repeat(43)
const NOW = 1_800_000_000_000

type AdminOptions = NonNullable<Parameters<typeof runOperatorAdmin>[1]>

interface Harness {
  stdout: string[]
  stderr: string[]
  options: AdminOptions
  advance(milliseconds: number): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function request(
  overrides: Partial<{
    requestId: string
    userCode: string
    clientName: string
    clientVersion: string
    createdAt: number
    expiresAt: number
  }> = {}
) {
  return {
    kind: 'cli' as const,
    requestId: REQUEST_ID,
    userCode: 'ABCD-EFGH',
    clientName: 'Motrix CLI',
    clientVersion: '1.2.3',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 299_000,
    ...overrides,
  }
}

function extensionRequest(
  overrides: Partial<{
    pairingNonce: string
    extensionId: string
    browser: 'chromium' | 'firefox'
    identity: 'official' | 'attested-non-official' | 'unverified'
    code: string
    createdAt: number
    expiresAt: number
  }> = {}
) {
  return {
    kind: 'extension' as const,
    pairingNonce: 'n'.repeat(43),
    extensionId: 'a'.repeat(32),
    browser: 'chromium' as const,
    identity: 'official' as const,
    code: 'JKLM-NPQR',
    createdAt: NOW - 500,
    expiresAt: NOW + 59_500,
    ...overrides,
  }
}

function harness(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: AdminOptions = {}
): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  let now = NOW
  return {
    stdout,
    stderr,
    options: {
      env: {
        MOTRIX_OPERATOR_TOKEN: TOKEN,
        PORT: '8123',
      },
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
      pendingRetryWindowMs: 0,
      ...overrides,
    },
    advance: (milliseconds) => {
      now += milliseconds
    },
  }
}

function rpcCall(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index]
  if (!call) throw new Error(`missing fetch call ${index}`)
  const [url, init] = call as [string, RequestInit]
  return {
    url,
    init,
    headers: new Headers(init.headers),
    body: JSON.parse(init.body as string) as { args: unknown[] },
  }
}

describe('runOperatorAdmin', () => {
  it('shows help without reading credentials or contacting the server', async () => {
    const fetchMock = vi.fn()
    const lstatMock = vi.fn()
    const h = harness(fetchMock, {
      env: {},
      lstat: lstatMock as unknown as NonNullable<AdminOptions['lstat']>,
    })

    await expect(runOperatorAdmin(['--help'], h.options)).resolves.toBe(
      OperatorAdminExitCode.Success
    )
    expect(h.stdout.join('\n')).toContain('motrix-admin pairing pending')
    expect(h.stderr).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(lstatMock).not.toHaveBeenCalled()
  })

  it('localizes help and usage errors from the configured host locale', async () => {
    const help = harness(vi.fn(), {
      env: {
        MOTRIX_HOST_LANGUAGE: 'zh-CN',
        LANG: 'en_US.UTF-8',
      },
    })

    await expect(runOperatorAdmin(['--help'], help.options)).resolves.toBe(
      OperatorAdminExitCode.Success
    )
    expect(help.stdout.join('\n')).toContain('用法：')
    expect(help.stdout.join('\n')).toContain('仅通过容器内的本机回环地址')

    const invalid = harness(vi.fn(), {
      env: {
        MOTRIX_HOST_LANGUAGE: 'zh-CN',
        LANG: 'en_US.UTF-8',
      },
    })
    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCI-0FGH'], invalid.options)
    ).resolves.toBe(OperatorAdminExitCode.Usage)
    expect(invalid.stderr.join('\n')).toContain(
      '配对码必须包含 8 个 ASCII 字符'
    )
    expect(invalid.stderr.join('\n')).toContain('查看用法')
  })

  it('rejects malformed and ambiguous human codes before network access', async () => {
    const fetchMock = vi.fn()
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCI-0FGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Usage)
    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCDEFGſ'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Usage)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.stderr.join('\n')).toContain('cannot use I, O, 0, or 1')
  })

  it('uses the environment credential and fixed loopback URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    const lstatMock = vi.fn()
    const h = harness(fetchMock, {
      lstat: lstatMock as unknown as NonNullable<AdminOptions['lstat']>,
    })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)

    const call = rpcCall(fetchMock, 0)
    expect(call.url).toBe(
      'http://127.0.0.1:8123/rpc/query/bridge%3AlistPendingPairRequests'
    )
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(call.body).toEqual({ args: [] })
    expect(lstatMock).not.toHaveBeenCalled()
  })

  it('reads the existing data-dir credential without provisioning it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    const lstatMock = vi.fn().mockResolvedValue({ isFile: () => true })
    const readFileMock = vi.fn().mockResolvedValue(TOKEN)
    const h = harness(fetchMock, {
      env: { MOTRIX_DATA_DIR: '/data' },
      lstat: lstatMock as unknown as NonNullable<AdminOptions['lstat']>,
      readFile: readFileMock as unknown as NonNullable<
        AdminOptions['readFile']
      >,
    })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(lstatMock).toHaveBeenCalledWith('/data/operator-token')
    expect(readFileMock).toHaveBeenCalledWith('/data/operator-token', 'utf8')
    expect(rpcCall(fetchMock, 0).headers.get('authorization')).toBe(
      `Bearer ${TOKEN}`
    )
  })

  it('fails with the credential exit code when no token can be read', async () => {
    const fetchMock = vi.fn()
    const h = harness(fetchMock, {
      env: {},
      lstat: vi
        .fn()
        .mockRejectedValue(new Error('missing')) as unknown as NonNullable<
        AdminOptions['lstat']
      >,
    })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Credential)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.stderr.join('\n')).not.toContain(TOKEN)
  })

  it('sanitizes and bounds untrusted client metadata in human output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        request({
          clientName: `bad\u001b[31m\n${'x'.repeat(180)}`,
          clientVersion: `2.0\u202e${'y'.repeat(55)}`,
        }),
      ])
    )
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(h.stdout).toHaveLength(1)
    expect(h.stdout[0]).not.toContain('\u001b')
    expect(h.stdout[0]).not.toContain('\n')
    expect(h.stdout[0]).not.toContain('\u202e')
    expect(h.stdout[0]?.length).toBeLessThan(170)
    expect(h.stdout[0]).not.toContain(REQUEST_ID)
    expect(h.stdout[0]).not.toContain(TOKEN)
  })

  it('projects JSON output without request ids or credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([request()]))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending', '--json'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    const output = h.stdout.join('')
    expect(JSON.parse(output)).toEqual({
      ok: true,
      requests: [
        {
          userCode: 'ABCD-EFGH',
          clientName: 'Motrix CLI',
          clientVersion: '1.2.3',
          createdAt: NOW - 1_000,
          expiresAt: NOW + 299_000,
        },
      ],
    })
    expect(output).not.toContain(REQUEST_ID)
    expect(output).not.toContain(TOKEN)
  })

  it('validates the pending union but prints only CLI requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([extensionRequest(), request()]))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending', '--json'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)

    const output = h.stdout.join('')
    expect(JSON.parse(output).requests).toHaveLength(1)
    expect(output).toContain('ABCD-EFGH')
    expect(output).not.toContain('JKLM-NPQR')
    expect(output).not.toContain('extension')
  })

  it('reports no CLI requests when only Extension pairing is pending', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([extensionRequest()]))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(h.stdout).toEqual(['No pending pairing requests.'])
    expect(h.stdout.join('')).not.toContain('JKLM-NPQR')
  })

  it('fails closed on a malformed Extension row instead of silently dropping it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([extensionRequest({ browser: 'safari' as never })])
      )
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('')).not.toContain('JKLM-NPQR')
  })

  it('sanitizes and bounds untrusted client metadata in JSON output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        request({
          clientName: `bad\u001b[31m\n\u2066${'x'.repeat(120)}`,
          clientVersion: `2.0\u202e\r${'y'.repeat(50)}`,
        }),
      ])
    )
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'pending', '--json'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    const output = h.stdout.join('')
    const parsed = JSON.parse(output) as {
      requests: Array<{ clientName: string; clientVersion: string }>
    }
    const projected = parsed.requests[0]
    expect(projected).toBeDefined()
    expect(projected?.clientName).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(projected?.clientVersion).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect([...(projected?.clientName ?? '')]).toHaveLength(80)
    expect([...(projected?.clientVersion ?? '')]).toHaveLength(32)
    expect(output).not.toContain(REQUEST_ID)
    expect(output).not.toContain(TOKEN)
  })

  it('retries pending queries on connection failures and startup 404s', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(jsonResponse({ error: 'unknown channel' }, 404))
      .mockResolvedValueOnce(jsonResponse([]))
    const h = harness(fetchMock, { pendingRetryWindowMs: 1_000 })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(h.stdout).toEqual(['No pending pairing requests.'])
  })

  it('does not retry a 404 that is not the exact unknown-channel response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse([]))
    const h = harness(fetchMock, { pendingRetryWindowMs: 1_000 })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.stderr.join('\n')).toContain('HTTP 404')
  })

  it('uses the unavailable exit code when loopback readiness times out', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('refused'))
    const h = harness(fetchMock, { pendingRetryWindowMs: 0 })

    await expect(
      runOperatorAdmin(['pairing', 'pending'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Unavailable)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes a code and approves exactly its unique request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(
        ['pairing', 'approve', ' abcd ', '-', 'efgh '],
        h.options
      )
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const mutation = rpcCall(fetchMock, 1)
    expect(mutation.url).toBe(
      'http://127.0.0.1:8123/rpc/command/bridge%3AresolvePair'
    )
    expect(mutation.body).toEqual({
      args: [
        {
          kind: 'cli',
          requestId: REQUEST_ID,
          decision: 'allow',
        },
      ],
    })
    expect(h.stdout).toEqual(['Approved ABCD-EFGH for Motrix CLI (1.2.3).'])
  })

  it('sends deny through the same authoritative decision RPC', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'deny', 'ABCDEFGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Success)
    expect(rpcCall(fetchMock, 1).body.args).toEqual([
      { kind: 'cli', requestId: REQUEST_ID, decision: 'deny' },
    ])
    expect(h.stdout[0]).toContain('Denied ABCD-EFGH')
  })

  it('fails closed when no request matches without sending a mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([request()]))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'JKLM-NPQR'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a code is not unique without sending a mutation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([
          request(),
          request({ requestId: 's'.repeat(43), clientName: 'Other CLI' }),
        ])
      )
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCD-EFGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.stderr.join('\n')).toContain('no decision was applied')
  })

  it('does not retry a failed mutation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockRejectedValueOnce(new TypeError('connection reset'))
    const h = harness(fetchMock, { pendingRetryWindowMs: 1_000 })

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCD-EFGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds a mutation with one timeout and never retries it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockImplementationOnce((_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new TypeError('aborted')),
            { once: true }
          )
        })
      })
    const h = harness(fetchMock, { mutationTimeoutMs: 1 })

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCD-EFGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.stderr.join('\n')).toContain('outcome is unknown')
  })

  it('honors the authoritative unavailable decision result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockResolvedValueOnce(jsonResponse({ ok: false, reason: 'unavailable' }))
    const h = harness(fetchMock)

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCD-EFGH'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(h.stdout).toEqual([])
  })

  it('rejects malformed pending and mutation responses strictly', async () => {
    const invalidPending = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ ...request(), token: 'leaked' }]))
    const pendingHarness = harness(invalidPending)

    await expect(
      runOperatorAdmin(['pairing', 'pending'], pendingHarness.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(pendingHarness.stdout).toEqual([])
    expect(pendingHarness.stderr.join('')).not.toContain('leaked')

    const invalidMutation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([request()]))
      .mockResolvedValueOnce(jsonResponse({ ok: true, token: 'leaked' }))
    const mutationHarness = harness(invalidMutation)
    await expect(
      runOperatorAdmin(
        ['pairing', 'approve', 'ABCD-EFGH'],
        mutationHarness.options
      )
    ).resolves.toBe(OperatorAdminExitCode.Server)
    expect(mutationHarness.stdout).toEqual([])
    expect(mutationHarness.stderr.join('')).not.toContain('leaked')
  })

  it('uses distinct credential and server failure exit codes', async () => {
    const unauthorizedFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401))
    const unauthorized = harness(unauthorizedFetch)
    await expect(
      runOperatorAdmin(['pairing', 'pending'], unauthorized.options)
    ).resolves.toBe(OperatorAdminExitCode.Credential)

    const failedFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'failure' }, 500))
    const failed = harness(failedFetch)
    await expect(
      runOperatorAdmin(['pairing', 'pending'], failed.options)
    ).resolves.toBe(OperatorAdminExitCode.Server)
  })

  it('emits granular machine error codes with localized messages', async () => {
    const h = harness(vi.fn(), {
      env: {
        MOTRIX_OPERATOR_TOKEN: TOKEN,
        MOTRIX_HOST_LANGUAGE: 'zh-CN',
      },
    })

    await expect(
      runOperatorAdmin(['pairing', 'approve', 'ABCI-0FGH', '--json'], h.options)
    ).resolves.toBe(OperatorAdminExitCode.Usage)
    expect(JSON.parse(h.stderr.join(''))).toEqual({
      ok: false,
      error: {
        code: 'usage.pairingCodeInvalid',
        kind: 'usage',
        message: '配对码必须包含 8 个 ASCII 字符，且不能使用 I、O、0 或 1。',
      },
    })
  })
})
