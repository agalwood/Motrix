import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NasSettingsStore } from './settings-store'

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-nas-settings-'))
  cleanup.push(root)
  await writeFile(
    path.join(root, 'package-settings.json'),
    JSON.stringify({
      clientPort: 16802,
      extensionUrl: '',
      operatorUrl: '',
      allowHttp: false,
    }),
    { mode: 0o600 }
  )
  await writeFile(
    path.join(root, 'directories.json'),
    JSON.stringify({ roots: ['/volume1/motrix'] }),
    { mode: 0o600 }
  )
  return { root, store: new NasSettingsStore(root, 'synology') }
}
describe.skipIf(process.platform === 'win32')(
  'NAS package configuration journal',
  () => {
    it('times out authority checks without blocking subsequent saves or accepting a late result', async () => {
      const { root } = await fixture()
      const store = new NasSettingsStore(root, 'synology', 20)
      const before = await store.view()
      let finish!: (value: boolean) => void
      let signal: AbortSignal | undefined
      const saved = await store.save(
        { revision: before.revision, settings: before.settings },
        async (_settings, current) => {
          signal = current
          return new Promise<boolean>((resolve) => {
            finish = resolve
          })
        }
      )
      expect(saved).toEqual({ ok: false, error: { code: 'unavailable' } })
      expect(signal?.aborted).toBe(true)
      finish(true)
      await expect(
        stat(path.join(root, 'pending-settings.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (
          await store.save(
            { revision: before.revision, settings: before.settings },
            async () => true
          )
        ).ok
      ).toBe(true)
    })
    it('rejects a valid schema whose serialized configuration exceeds the journal bound', async () => {
      const { root, store } = await fixture(),
        before = await store.view()
      expect(
        await store.save(
          {
            revision: before.revision,
            settings: {
              ...before.settings,
              roots: Array.from(
                { length: 64 },
                (_, index) => `/volume1/${index}${'x'.repeat(600)}`
              ),
            },
          },
          async () => true
        )
      ).toEqual({ ok: false, error: { code: 'invalid' } })
      await expect(
        stat(path.join(root, 'pending-settings.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('queues validated settings without changing live grants or client settings', async () => {
      const { root, store } = await fixture(),
        before = await store.view()
      const settings = {
        ...before.settings,
        roots: ['/volume1/motrix', '/volume1/downloads'],
        clientPort: 16812,
      }
      const saved = await store.save(
        { revision: before.revision, settings },
        async () => true
      )
      expect(saved).toMatchObject({
        ok: true,
        value: { settings, restartRequired: true, active: before.settings },
      })
      expect(
        JSON.parse(await readFile(path.join(root, 'directories.json'), 'utf8'))
      ).toEqual({ roots: ['/volume1/motrix'] })
      expect(
        JSON.parse(
          await readFile(path.join(root, 'package-settings.json'), 'utf8')
        ).clientPort
      ).toBe(16802)
      expect(
        (await stat(path.join(root, 'pending-settings.json'))).mode & 0o777
      ).toBe(0o600)
    })
    it('rejects stale and concurrently changed snapshots without overwriting them', async () => {
      const { root, store } = await fixture(),
        before = await store.view()
      const first = {
        revision: before.revision,
        settings: { ...before.settings, clientPort: 16812 },
      }
      expect((await store.save(first, async () => true)).ok).toBe(true)
      expect(await store.save(first, async () => true)).toEqual({
        ok: false,
        error: { code: 'conflict' },
      })
      const current = await store.view()
      expect(
        await store.save(
          {
            revision: current.revision,
            settings: { ...current.settings, clientPort: 16813 },
          },
          async () => {
            await writeFile(
              path.join(root, 'directories.json'),
              JSON.stringify({ roots: ['/volume1/changed'] }),
              { mode: 0o600 }
            )
            return true
          }
        )
      ).toEqual({ ok: false, error: { code: 'conflict' } })
      expect(
        JSON.parse(
          await readFile(path.join(root, 'pending-settings.json'), 'utf8')
        ).clientPort
      ).toBe(16812)
    })
    it('does not create pending grants after authorization failure or malformed input', async () => {
      const { root, store } = await fixture(),
        before = await store.view()
      expect(
        await store.save(
          { revision: before.revision, settings: before.settings },
          async () => false
        )
      ).toEqual({ ok: false, error: { code: 'permissionDenied' } })
      expect(
        await store.save(
          {
            revision: before.revision,
            settings: { ...before.settings, clientPort: 65536 },
          },
          async () => true
        )
      ).toEqual({ ok: false, error: { code: 'invalid' } })
      await expect(
        stat(path.join(root, 'pending-settings.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('refuses symlinked and non-private state documents', async () => {
      const { root, store } = await fixture()
      await symlink(
        path.join(root, 'directories.json'),
        path.join(root, 'pending-settings.json')
      )
      await expect(store.view()).rejects.toThrow()
      await rm(path.join(root, 'pending-settings.json'))
      await writeFile(path.join(root, 'pending-settings.json'), '{}', {
        mode: 0o644,
      })
      await expect(store.view()).rejects.toThrow()
    })
  }
)
