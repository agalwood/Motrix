import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DownloadErrorCode } from '@shared/errors'
import { TaskStatus } from '@shared/types/task'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import { describe, expect, it } from 'vitest'
import { translateRawToTask } from './translate'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'aria2 BT listening port recovery',
  () => {
    it('reports the bind failure through RPC and starts metadata resolution once the port is free', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'motrix-bt-port-'))
      const occupied = createServer()
      let handle: Aria2Handle | undefined
      let disconnect: (() => void) | undefined
      try {
        occupied.listen(0, '127.0.0.1')
        await once(occupied, 'listening')
        const address = occupied.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing test port')
        handle = await spawnAria2ForTest({
          baseDir: root,
          extraArgs: [
            '--interface=127.0.0.1',
            '--disable-ipv6=true',
            '--enable-dht6=false',
            '--bt-enable-lpd=false',
            '--bt-exclude-tracker=*',
            `--listen-port=${address.port}`,
          ],
        })
        const connection = await connectAdapter(handle)
        disconnect = connection.disconnect
        const { rpc } = connection
        const magnet =
          'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
        const gid = await rpc.addUri([magnet], { 'bt-metadata-only': 'true' })
        await expect
          .poll(async () => (await rpc.tellStatus(gid)).status, {
            timeout: 5000,
          })
          .toBe('error')
        expect(translateRawToTask(await rpc.tellStatus(gid))).toMatchObject({
          status: TaskStatus.Error,
          errorCode: DownloadErrorCode.BtPortBindFailed,
          errorMessage: expect.stringContaining(
            'Errors occurred while binding port.'
          ),
        })

        await new Promise<void>((resolve, reject) =>
          occupied.close((error) => (error ? reject(error) : resolve()))
        )
        await rpc.removeDownloadResult(gid)
        const retryGid = await rpc.addUri([magnet], {
          'bt-metadata-only': 'true',
        })
        await expect
          .poll(async () => (await rpc.tellStatus(retryGid)).status, {
            timeout: 5000,
          })
          .toBe('active')
        expect(
          translateRawToTask(await rpc.tellStatus(retryGid))
        ).toMatchObject({
          status: TaskStatus.FetchingMetadata,
          errorCode: null,
          errorMessage: null,
        })
      } finally {
        disconnect?.()
        await handle?.kill()
        if (occupied.listening)
          await new Promise<void>((resolve) => occupied.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }, 15000)
  }
)
