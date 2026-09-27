// Test-only controller for the installed package experiment. Protocol and
// cryptography come from the existing MBP1 test client.
// This is a synthetic Node peer, not evidence of browser-origin attestation.

import {
  InitializeResultSchema,
  type MdxpConnection,
  Methods,
  Notifications,
  TaskListResultSchema,
} from '@motrix/mdxp'
import type { EnvelopeChannel } from '../mbp1/envelope-message-stream'
import type { IssuedCredential, WireClient } from './mbp1-client'
import * as client from './mbp1-client'

const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const origin = `chrome-extension://${extensionId}`
function fail(code: string): never {
  throw new Error(code)
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('mbp1-operation-timeout')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createInstalledMbp1Client() {
  let credential: IssuedCredential | undefined
  let instanceId: string | undefined
  let paired = false
  let disposed = false
  let wire: WireClient | undefined
  let connection: MdxpConnection | undefined

  async function closeConnection() {
    connection?.dispose()
    connection = undefined
    if (wire) {
      const current = wire
      wire = undefined
      current.ws.terminate()
      await bounded(current.closed, 3000)
      current.rawFrames.length = 0
    }
  }

  async function initializeAndRead(channel: EnvelopeChannel) {
    if (!wire) fail('mbp1-client-state-invalid')
    connection = client.mdxpOverChannel(wire, channel)
    const initialized = await bounded(
      connection.sendRequest(
        Methods.MotrixInitialize,
        client.initializeParams(extensionId)
      ),
      10000
    )
    if (
      !InitializeResultSchema.safeParse(initialized).success ||
      initialized.server.name !== 'motrix' ||
      Object.hasOwn(initialized, 'pairToken')
    ) {
      fail('mbp1-initialize-invalid')
    }
    connection.sendNotification(Notifications.MotrixInitialized, undefined)
    const tasks = TaskListResultSchema.safeParse(
      await bounded(connection.sendRequest(Methods.TaskList, {}), 10000)
    )
    // The disposable fresh test profile has no tasks. Do not retain task data.
    if (!tasks.success || tasks.data.tasks.length !== 0)
      fail('mbp1-read-invalid')
  }

  return Object.freeze({
    async pair(
      port: number,
      pairNonce: string,
      readCode: () => string | Promise<string>
    ) {
      if (disposed || paired || credential) fail('mbp1-client-state-invalid')
      try {
        const handshake = await client.startPair({
          port,
          pairNonce,
          origin,
          browser: 'chromium',
          claimedExtensionId: extensionId,
          clientInstallationId: 'windows-store-installed-probe',
        })
        wire = handshake.wire
        instanceId = handshake.instanceId
        const { channel } = await client.runPake(handshake, await readCode())
        credential = await client.exchangeCredential(handshake, channel)
        await initializeAndRead(channel)
        paired = true
      } catch {
        fail('mbp1-pair-failed')
      } finally {
        await closeConnection()
      }
    },
    async reconnect(port: number) {
      if (disposed || !paired || !credential || !instanceId)
        fail('mbp1-client-state-invalid')
      try {
        const resumed = await client.reconnect({
          port,
          origin,
          instanceId,
          credential,
        })
        wire = resumed.wire
        await initializeAndRead(resumed.channel)
      } catch {
        fail('mbp1-reconnect-failed')
      } finally {
        await closeConnection()
      }
    },
    async dispose() {
      disposed = true
      paired = false
      credential?.mutualKey.fill(0)
      credential = undefined
      instanceId = undefined
      await closeConnection()
    },
  })
}
