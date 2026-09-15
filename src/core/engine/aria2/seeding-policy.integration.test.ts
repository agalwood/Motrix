import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { EngineSettings } from '@shared/types/settings'
import { TaskStatus } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '../../../test-utils/aria2'
import { Aria2Adapter } from './aria2-adapter'
import { Aria2ConfigBuilder } from './aria2-config-builder'

type SeedingDefaults = Pick<EngineSettings, 'seedTime' | 'seedRatio'>
const payload = Buffer.alloc(1024, 42)
// A single-piece local torrent with no trackers, web seeds or discovery hints.
const metadata = Buffer.concat([
  Buffer.from(
    `d4:infod6:lengthi${payload.length}e4:name11:payload.bin12:piece lengthi16384e6:pieces20:`
  ),
  createHash('sha1').update(payload).digest(),
  Buffer.from('ee'),
])

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'seeding policy with real aria2',
  () => {
    let directory: string
    let handle: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>
    let adapter: Aria2Adapter
    let defaults: SeedingDefaults

    async function start(inputSession = false, configPath?: string) {
      handle = await spawnAria2ForTest({
        baseDir: directory,
        extraArgs: [
          ...(configPath
            ? ['--no-conf=false', `--conf-path=${configPath}`]
            : []),
          '--enable-dht6=false',
          '--bt-enable-lpd=false',
          '--seed-ratio=0',
          '--force-save=true',
          `--save-session=${path.join(directory, 'session.txt')}`,
          ...(inputSession
            ? [`--input-file=${path.join(directory, 'session.txt')}`]
            : []),
        ],
      })
      wired = await connectAdapter(handle)
      adapter = new Aria2Adapter(wired.rpc, undefined, () => defaults)
      await adapter.connect()
    }
    async function stop() {
      adapter?.dispose()
      wired?.adapter.dispose()
      wired?.disconnect()
      await handle?.kill()
    }
    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'motrix-seeding-policy-'))
      defaults = { seedTime: 0, seedRatio: 0 }
      await writeFile(path.join(directory, 'payload.bin'), payload)
      await start()
    })
    afterEach(async () => {
      await stop()
      await rm(directory, { recursive: true, force: true })
    })
    async function add(overrides: Partial<SeedingDefaults> = {}) {
      return adapter.addTorrent({
        metadata,
        saveDir: directory,
        btSeedUnverified: true,
        ...overrides,
      })
    }
    async function expectStatus(gid: string, status: TaskStatus) {
      await expect
        .poll(async () => (await adapter.getTaskStatus(gid))?.status, {
          timeout: 5000,
        })
        .toBe(status)
    }
    async function expectKeepsSeeding(gid: string) {
      await expectStatus(gid, TaskStatus.Seeding)
      // The broken zero/empty timer retires on the next engine tick.
      await delay(1500)
      expect((await adapter.getTaskStatus(gid))?.status).toBe(
        TaskStatus.Seeding
      )
      expect(await adapter.getEngineTaskOptions(gid)).not.toHaveProperty(
        'seed-time'
      )
    }

    it.each([0, 1])(
      'zero time continues seeding with ratio %s',
      async (seedRatio) => {
        defaults.seedRatio = seedRatio
        await expectKeepsSeeding(await add())
      }
    )
    it('positive time ends seeding even when ratio is unlimited', async () => {
      defaults.seedTime = 0.02
      await expectStatus(await add(), TaskStatus.Completed)
    })
    it('hot defaults apply to the next seeding session without leaving a global timer', async () => {
      defaults.seedTime = 60
      const previous = await add()
      await expectStatus(previous, TaskStatus.Seeding)
      expect(await adapter.getEngineTaskOptions(previous)).toHaveProperty(
        'seed-time',
        '60'
      )
      await adapter.forceRemoveTask(previous)
      await expectStatus(previous, TaskStatus.Completed)
      await adapter.removeDownloadResult(previous)
      defaults.seedTime = 0
      await expectKeepsSeeding(await add())
      expect(await wired.rpc.getGlobalOption()).not.toHaveProperty('seed-time')
    }, 15_000)
    it('an explicit unlimited task overrides finite application defaults', async () => {
      defaults.seedTime = 60
      await expectKeepsSeeding(await add({ seedTime: 0 }))
    })
    it('advanced global time cannot override unlimited application settings', async () => {
      await stop()
      const configPath = path.join(directory, 'aria2.conf')
      const source = 'seed-time=0\nseed-ratio=2\n'
      await writeFile(configPath, source)
      const builder = new Aria2ConfigBuilder(configPath, directory)
      const runtimeConfig = await builder.ensureUserConfig()
      await start(false, runtimeConfig)
      expect(await readFile(configPath, 'utf8')).toBe(source)
      expect(await wired.rpc.getGlobalOption()).not.toHaveProperty('seed-time')
      await expectKeepsSeeding(await add())
    }, 15_000)
    it('unlimited seeding survives pause, resume and text-session restart', async () => {
      const gid = await add()
      await expectStatus(gid, TaskStatus.Seeding)
      await adapter.pauseTask(gid)
      await expectStatus(gid, TaskStatus.Paused)
      await adapter.resumeTask(gid)
      await expectStatus(gid, TaskStatus.Seeding)
      await wired.rpc.saveSession()
      expect(
        await readFile(path.join(directory, 'session.txt'), 'utf8')
      ).not.toContain('seed-time=')
      await stop()
      await start(true)
      await expectKeepsSeeding(gid)
    }, 15_000)
  }
)
