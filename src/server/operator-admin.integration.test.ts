import { DeviceCodeService } from '@core/bridge/device-code-service'
import type { PairedClient, PairingService } from '@core/bridge/pairing-service'
import { resolveCliPair } from '@core/bridge/resolve-cli-pair'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { OperatorAdminExitCode, runOperatorAdmin } from './operator-admin'

const OPERATOR_TOKEN = 'o'.repeat(43)
const AGENT_TOKEN = 'agent-token-that-only-the-requesting-client-may-poll'

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('motrix-admin pairing integration', () => {
  it('approves a real pending device code without disclosing capabilities', async () => {
    const paired: PairedClient = {
      identity: { kind: 'cli', id: 'device-id-for-admin-integration' },
      name: 'Integration CLI',
      token: AGENT_TOKEN,
      pairedAt: 1,
      lastActiveAt: null,
    }
    const pairing = {
      issueToken: vi.fn().mockResolvedValue(paired),
    } as unknown as PairingService
    const deviceCodes = new DeviceCodeService(pairing)
    const pending = deviceCodes.request(
      'Integration CLI',
      '0.4.0',
      'device-id-for-admin-integration'
    )
    const stdout: string[] = []
    const stderr: string[] = []

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url.endsWith(
          `/rpc/query/${encodeURIComponent(
            BridgeQueries.ListPendingPairRequests
          )}`
        )
      ) {
        return response(deviceCodes.listPending())
      }
      expect(url).toBe(
        `http://127.0.0.1:8080/rpc/command/${encodeURIComponent(
          BridgeCommands.ResolvePair
        )}`
      )
      const body = JSON.parse(String(init?.body)) as {
        args: Array<{
          kind: 'cli'
          requestId: string
          decision: 'allow' | 'deny'
        }>
      }
      return response(
        await resolveCliPair(deviceCodes, body.args[0]!, () => {})
      )
    })

    const exitCode = await runOperatorAdmin(
      ['pairing', 'approve', pending.userCode, '--json'],
      {
        env: { MOTRIX_OPERATOR_TOKEN: OPERATOR_TOKEN },
        fetch: fetchMock as typeof fetch,
        writeStdout: (line) => stdout.push(line),
        writeStderr: (line) => stderr.push(line),
      }
    )

    expect(exitCode).toBe(OperatorAdminExitCode.Success)
    expect(pairing.issueToken).toHaveBeenCalledOnce()
    expect(deviceCodes.poll(pending.requestId)).toEqual({
      status: 'approved',
      token: AGENT_TOKEN,
    })
    const output = [...stdout, ...stderr].join('\n')
    expect(output).not.toContain(pending.requestId)
    expect(output).not.toContain(OPERATOR_TOKEN)
    expect(output).not.toContain(AGENT_TOKEN)
    deviceCodes.dispose()
  })
})
