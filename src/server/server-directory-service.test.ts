import { constants, type Dir, type Dirent } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerDownloadPathPolicy } from './download-path-policy'
import { ServerDirectoryService } from './server-directory-service'

const temporary: string[] = []
async function fixture(unrestricted = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-directory-'))
  temporary.push(root)
  const downloads = path.join(root, 'downloads')
  const policy = await createServerDownloadPathPolicy({
    defaultSaveDir: downloads,
    allowedSaveDirsValue: unrestricted ? undefined : downloads,
  })
  return {
    root,
    downloads,
    policy,
    service: new ServerDirectoryService(policy),
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('ServerDirectoryService', () => {
  it('lists only immediate authorized directories with deterministic natural order and hidden filter', async () => {
    const { root, downloads, service } = await fixture()
    await Promise.all(
      ['folder10', 'folder2', '.hidden', 'outer/nested'].map((name) =>
        mkdir(path.join(downloads, name), { recursive: true })
      )
    )
    await writeFile(path.join(downloads, 'file'), '')
    await mkdir(path.join(root, 'outside'))
    await symlink(path.join(root, 'outside'), path.join(downloads, 'escape'))
    await symlink(
      path.join(downloads, 'missing'),
      path.join(downloads, 'broken')
    )
    const result = await service.list({ path: downloads })
    expect(result).toEqual({
      ok: true,
      value: {
        path: downloads,
        parentPath: null,
        breadcrumbs: [{ name: 'downloads', path: downloads }],
        entries: ['folder2', 'folder10', 'outer'].map((name) => ({
          name,
          path: path.join(downloads, name),
          modifiedAt: expect.any(Number),
        })),
        truncated: false,
        canCreate: true,
      },
    })
    const hidden = await service.list({ path: downloads, showHidden: true })
    expect(
      hidden.ok && hidden.value.entries.map((entry) => entry.name)
    ).toContain('.hidden')
    expect(
      await service.list({ path: path.join(downloads, 'escape') })
    ).toEqual({ ok: false, error: { code: 'outsideRoots' } })
  })

  it('returns authorized target modification times only on listing entries', async () => {
    const { downloads, service } = await fixture()
    const target = path.join(downloads, 'target')
    const alias = path.join(downloads, 'alias')
    await mkdir(target)
    await symlink(target, alias)
    await utimes(target, new Date(1700000000123), new Date(1700000000123))
    const expected = (await stat(target)).mtimeMs
    const result = await service.list({ path: downloads })
    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [
          { name: 'alias', path: alias, modifiedAt: expected },
          { name: 'target', path: target, modifiedAt: expected },
        ],
      },
    })
    expect(result.ok && result.value.breadcrumbs).toEqual([
      { name: 'downloads', path: downloads },
    ])
    expect(
      await service.create({ parentPath: downloads, name: 'new' })
    ).toEqual({
      ok: true,
      value: { name: 'new', path: path.join(downloads, 'new') },
    })
    const locations = await service.locations(
      {},
      {
        defaultSaveDir: downloads,
        directoryPreferences: { favorites: [alias], recent: [target] },
      }
    )
    expect(locations.ok).toBe(true)
    if (locations.ok) {
      for (const group of Object.values(locations.value))
        for (const entry of group)
          expect(entry).not.toHaveProperty('modifiedAt')
    }
  })

  it.each([undefined, Number.NaN, Infinity, -Infinity])(
    'keeps children with unavailable metadata selectable: %s',
    async (modifiedAt) => {
      const { downloads, policy } = await fixture()
      const childPath = path.join(downloads, 'child')
      await mkdir(childPath)
      const authorize = policy.authorizeDirectory.bind(policy)
      vi.spyOn(policy, 'authorizeDirectory').mockImplementation(
        async (candidate) => {
          const result = await authorize(candidate)
          if (candidate === childPath) return { ...result, modifiedAt }
          return result
        }
      )
      const result = await new ServerDirectoryService(policy).list({
        path: downloads,
      })
      expect(result.ok && result.value.entries).toEqual([
        { name: 'child', path: childPath },
      ])
    }
  )

  it('skips cyclic child links while keeping direct access to the cycle unavailable', async () => {
    const { downloads, service } = await fixture()
    const visible = path.join(downloads, 'visible')
    const cycle = path.join(downloads, 'cycle')
    await mkdir(visible)
    await symlink('cycle', cycle)

    expect(await service.list({ path: downloads })).toMatchObject({
      ok: true,
      value: {
        entries: [{ name: 'visible', path: visible }],
        truncated: false,
      },
    })
    const unavailable = { ok: false, error: { code: 'unavailable' } }
    expect(await service.list({ path: cycle })).toEqual(unavailable)
    expect(await service.validate({ path: cycle })).toEqual(unavailable)
    expect(await service.create({ parentPath: cycle, name: 'child' })).toEqual(
      unavailable
    )
  })

  it('skips an overlong child link target without hiding siblings or accepting direct access', async () => {
    const { downloads, service } = await fixture()
    const visible = path.join(downloads, 'visible')
    const broken = path.join(downloads, 'broken')
    await mkdir(visible)
    await symlink('x'.repeat(256), broken)

    expect(await service.list({ path: downloads })).toMatchObject({
      ok: true,
      value: {
        entries: [{ name: 'visible', path: visible }],
        truncated: false,
      },
    })
    const tooLarge = { ok: false, error: { code: 'tooLarge' } }
    expect(await service.list({ path: broken })).toEqual(tooLarge)
    expect(await service.validate({ path: broken })).toEqual(tooLarge)
    expect(await service.create({ parentPath: broken, name: 'child' })).toEqual(
      tooLarge
    )
  })

  it('browses and validates without prepare, mkdir or write probes, including missing and invalid paths', async () => {
    const { downloads, policy } = await fixture()
    const prepare = vi.spyOn(policy, 'prepareSaveDir')
    const create = vi.fn(mkdir)
    const service = new ServerDirectoryService(policy, {
      access,
      mkdir: create as typeof mkdir,
      opendir,
    })
    expect((await service.list({ path: downloads })).ok).toBe(true)
    expect(await service.validate({ path: downloads })).toEqual({
      ok: true,
      value: { path: downloads },
    })
    expect(
      await service.validate({ path: path.join(downloads, 'missing') })
    ).toEqual({ ok: false, error: { code: 'notFound' } })
    expect(await service.list({ path: 'relative' })).toEqual({
      ok: false,
      error: { code: 'invalidPath' },
    })
    expect(await service.validate({ path: `${downloads}\0` })).toEqual({
      ok: false,
      error: { code: 'invalidPath' },
    })
    await writeFile(path.join(downloads, 'file'), '')
    expect(await service.list({ path: path.join(downloads, 'file') })).toEqual({
      ok: false,
      error: { code: 'notDirectory' },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(await readdir(downloads)).toEqual(['file'])
  })

  it('uses deepest logical root boundaries and unrestricted filesystem roots', async () => {
    const { root, downloads } = await fixture()
    const nested = path.join(downloads, 'nested')
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
      allowedSaveDirsValue: [downloads, nested].join(path.delimiter),
    })
    const service = new ServerDirectoryService(policy)
    expect(await service.list({ path: nested })).toMatchObject({
      ok: true,
      value: {
        parentPath: null,
        breadcrumbs: [{ name: 'nested', path: nested }],
      },
    })
    const unrestricted = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
    })
    expect(
      await new ServerDirectoryService(unrestricted).list({ path: root })
    ).toMatchObject({
      ok: true,
      value: {
        parentPath: path.dirname(root),
        breadcrumbs: expect.arrayContaining([
          { name: path.parse(root).root, path: path.parse(root).root },
        ]),
      },
    })
  })

  it('keeps configured root and internal aliases, while canonical values round-trip', async () => {
    const { root, downloads } = await fixture()
    const alias = path.join(root, 'alias')
    await symlink(downloads, alias)
    await mkdir(path.join(downloads, 'real-child'))
    await symlink(
      path.join(downloads, 'real-child'),
      path.join(downloads, 'internal')
    )
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: alias,
      allowedSaveDirsValue: alias,
    })
    const service = new ServerDirectoryService(policy)
    const logical = path.join(alias, 'internal')
    expect(await service.validate({ path: logical })).toEqual({
      ok: true,
      value: { path: logical },
    })
    const prepared = await policy.prepareSaveDir(logical)
    expect(prepared).toBe(await realpath(logical))
    expect(await service.validate({ path: prepared })).toEqual({
      ok: true,
      value: { path: path.join(alias, 'real-child') },
    })
    expect(await policy.prepareSaveDir(prepared)).toBe(prepared)
    expect(await service.create({ parentPath: logical, name: 'new' })).toEqual({
      ok: true,
      value: { path: path.join(logical, 'new'), name: 'new' },
    })
  })

  it('creates exactly one persistent child, preserving legal POSIX whitespace identity', async () => {
    const { downloads, policy, service } = await fixture()
    for (const name of process.platform === 'win32'
      ? ['Movies']
      : ['Movies', 'Movies ', ' ']) {
      const child = path.join(downloads, name)
      expect(await service.create({ parentPath: downloads, name })).toEqual({
        ok: true,
        value: { path: child, name },
      })
      expect(await service.validate({ path: child })).toEqual({
        ok: true,
        value: { path: child },
      })
      expect(await policy.prepareSaveDir(child)).toBe(await realpath(child))
      expect(await service.create({ parentPath: downloads, name })).toEqual({
        ok: false,
        error: { code: 'alreadyExists' },
      })
    }
    expect(
      await service.create({
        parentPath: path.join(downloads, 'missing'),
        name: 'child',
      })
    ).toEqual({ ok: false, error: { code: 'notFound' } })
    expect(await readdir(downloads)).not.toContain('missing')
  })

  it.each([
    '',
    '.',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'a\0b',
    'a\nb',
    'x'.repeat(256),
  ])('rejects non-filename input %j', async (name) => {
    const { downloads, service } = await fixture()
    expect(await service.create({ parentPath: downloads, name })).toEqual({
      ok: false,
      error: { code: 'invalidName' },
    })
    expect(await readdir(downloads)).toEqual([])
  })

  it('rejects Windows forbidden names on a Windows host before touching the filesystem', async () => {
    const { downloads, service } = await fixture()
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { value: 'win32' } })
    )
    try {
      for (const name of [
        'CON',
        'nul.txt',
        'COM1.log',
        'LPT9',
        'COM¹.txt',
        'folder ',
        'folder.',
        'a:b',
        'a*',
        'a?',
        'a|',
        'a"',
        'a<',
        'a>',
      ]) {
        expect(await service.create({ parentPath: downloads, name })).toEqual({
          ok: false,
          error: { code: 'invalidName' },
        })
      }
      expect(await readdir(downloads)).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not create through an escaping parent symlink', async () => {
    const { root, downloads, service } = await fixture()
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(downloads, 'escape'))
    expect(
      await service.create({
        parentPath: path.join(downloads, 'escape'),
        name: 'new',
      })
    ).toEqual({ ok: false, error: { code: 'outsideRoots' } })
    expect(await readdir(outside)).toEqual([])
  })

  it('reports advisory permissions and does not claim validation can write', async () => {
    const { downloads, policy } = await fixture()
    const denied = Object.assign(new Error('secret permission detail'), {
      code: 'EACCES',
    })
    const create = vi.fn(mkdir)
    const service = new ServerDirectoryService(policy, {
      access: vi.fn(async (candidate, mode) => {
        if ((mode ?? 0) & constants.W_OK) throw denied
        return access(candidate, mode)
      }),
      mkdir: create as typeof mkdir,
      opendir,
    })
    expect(await service.list({ path: downloads })).toMatchObject({
      ok: true,
      value: { canCreate: false },
    })
    expect(await service.validate({ path: downloads })).toEqual({
      ok: false,
      error: { code: 'permissionDenied' },
    })
    expect(
      await service.create({ parentPath: downloads, name: 'new' })
    ).toEqual({ ok: false, error: { code: 'permissionDenied' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('sanitizes actual OS permission failures', async () => {
    const { downloads, service } = await fixture()
    await chmod(downloads, 0o000)
    try {
      expect(await service.list({ path: downloads })).toEqual({
        ok: false,
        error: { code: 'permissionDenied' },
      })
    } finally {
      await chmod(downloads, 0o700)
    }
  })

  it('returns unknown outcome after successful mkdir whose post-check fails, and never deletes it', async () => {
    const { downloads, policy } = await fixture()
    const original = policy.authorizeDirectory.bind(policy)
    vi.spyOn(policy, 'authorizeDirectory').mockImplementation(
      async (candidate) => {
        if (candidate === path.join(downloads, 'new'))
          throw Object.assign(new Error('private detail'), { code: 'EIO' })
        return original(candidate)
      }
    )
    const service = new ServerDirectoryService(policy)
    expect(
      await service.create({ parentPath: downloads, name: 'new' })
    ).toEqual({ ok: false, error: { code: 'creationOutcomeUnknown' } })
    expect((await stat(path.join(downloads, 'new'))).isDirectory()).toBe(true)
  })

  it.each([
    { directory: false, limit: 10000 },
    { directory: true, limit: 2000 },
  ])(
    'bounds scan and result work and closes capped handles: %j',
    async ({ directory, limit }) => {
      const { downloads, policy } = await fixture()
      const authorize = vi.spyOn(policy, 'authorizeDirectory')
      const parent = await policy.authorizeDirectory(downloads)
      authorize.mockImplementation(async (candidate) => ({
        ...parent,
        path: candidate,
      }))
      const read = vi.fn(
        async () =>
          ({
            name: `folder${read.mock.calls.length}`,
            isDirectory: () => directory,
            isSymbolicLink: () => false,
          }) as Dirent
      )
      const close = vi.fn(async () => undefined)
      const service = new ServerDirectoryService(policy, {
        access,
        mkdir,
        opendir: vi.fn(
          async () => ({ read, close }) as unknown as Dir
        ) as typeof opendir,
      })
      const result = await service.list({ path: downloads })
      expect(result).toMatchObject({ ok: true, value: { truncated: true } })
      expect(read).toHaveBeenCalledTimes(limit)
      expect(close).toHaveBeenCalledOnce()
      expect(result.ok && result.value.entries.length).toBe(
        directory ? 2000 : 0
      )
    }
  )

  it('closes handles when reading fails and sanitizes the filesystem error', async () => {
    const { downloads, policy } = await fixture()
    const close = vi.fn(async () => undefined)
    const service = new ServerDirectoryService(policy, {
      access,
      mkdir,
      opendir: vi.fn(
        async () =>
          ({
            read: vi.fn().mockRejectedValue(new Error('private detail')),
            close,
          }) as unknown as Dir
      ) as typeof opendir,
    })
    expect(await service.list({ path: downloads })).toEqual({
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('ServerDirectoryService locations', () => {
  it('discovers existing unrestricted common places without creating missing directories and preserves semantic duplicates', async () => {
    const { root, policy, downloads } = await fixture(true)
    await mkdir(path.join(root, 'Desktop'))
    await mkdir(path.join(root, 'Downloads'), { recursive: true })
    const fs = {
      access: vi.fn(access),
      mkdir: vi.fn(mkdir) as typeof mkdir,
      opendir,
    }
    const service = new ServerDirectoryService(policy, fs, () => root)
    const result = await service.locations(
      {},
      {
        defaultSaveDir: root,
        directoryPreferences: { favorites: [], recent: [] },
      }
    )
    expect(result).toEqual({
      ok: true,
      value: {
        common: [
          { kind: 'default', path: root },
          { kind: 'home', path: root },
          { kind: 'desktop', path: path.join(root, 'Desktop') },
          { kind: 'downloads', path: path.join(root, 'Downloads') },
          { kind: 'root', path: path.parse(root).root },
        ],
        favorites: [],
        recent: [],
      },
    })
    expect(fs.mkdir).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(['Desktop', path.basename(downloads)])
    )
    expect(await readdir(root)).not.toContain('Documents')
    expect(
      fs.access.mock.calls.every(
        ([, mode]) => mode === (constants.R_OK | constants.X_OK)
      )
    ).toBe(true)
  })

  it('filters inaccessible/outside/stale records and canonically groups all saved identities into authorized aliases', async () => {
    const { root, downloads, policy } = await fixture()
    const target = path.join(downloads, 'target')
    const alias = path.join(downloads, 'alias')
    const outside = path.join(root, 'outside')
    await mkdir(target)
    await mkdir(outside)
    await symlink(target, alias)
    await symlink(outside, path.join(downloads, 'escape'))
    const canonical = await realpath(target)
    const preferences = {
      favorites: [
        alias,
        canonical,
        outside,
        path.join(downloads, 'escape'),
        path.join(downloads, 'missing'),
      ],
      recent: [canonical],
    }
    const service = new ServerDirectoryService(
      policy,
      { access, mkdir, opendir },
      () => root
    )
    const result = await service.locations(
      {},
      { defaultSaveDir: downloads, directoryPreferences: preferences }
    )
    expect(result).toEqual({
      ok: true,
      value: {
        common: [{ kind: 'default', path: downloads }],
        favorites: [
          { name: 'alias', path: alias, sourcePaths: [alias, canonical] },
        ],
        recent: [{ name: 'alias', path: alias, sourcePaths: [canonical] }],
      },
    })
    expect(preferences.favorites).toHaveLength(5)
    const denied = new ServerDirectoryService(
      policy,
      {
        access: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('secret'), { code: 'EACCES' })
          ),
        mkdir,
        opendir,
      },
      () => root
    )
    expect(
      await denied.locations(
        {},
        { defaultSaveDir: downloads, directoryPreferences: preferences }
      )
    ).toEqual({ ok: true, value: { common: [], favorites: [], recent: [] } })
  })

  it('rejects client-supplied location arrays before discovery and validates saved additions readonly', async () => {
    const { downloads, policy } = await fixture()
    const authorize = vi.spyOn(policy, 'authorizeDirectory')
    const fs = {
      access: vi.fn(access),
      mkdir: vi.fn(mkdir) as typeof mkdir,
      opendir,
    }
    const service = new ServerDirectoryService(policy, fs)
    expect(
      await service.locations(
        { favorites: [downloads] },
        {
          defaultSaveDir: downloads,
          directoryPreferences: { favorites: [], recent: [] },
        }
      )
    ).toEqual({ ok: false, error: { code: 'invalidPath' } })
    expect(authorize).not.toHaveBeenCalled()
    expect(await service.resolvePreferenceDirectory(downloads)).toBe(downloads)
    expect(fs.access).toHaveBeenCalledWith(
      await realpath(downloads),
      constants.R_OK | constants.X_OK
    )
    expect(fs.mkdir).not.toHaveBeenCalled()
  })
})
