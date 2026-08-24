import { describe, expect, it, vi } from 'vitest'

import {
  buildDesktopEntry,
  classifyDefaultHandler,
  classifyDesktopFile,
  DEFAULT_INTEGRATION_RECORD,
  DESKTOP_ENTRY_ID,
  desktopEntryFilePath,
  enableSystemIntegration,
  execTargetsAppImage,
  type IntegrationFs,
  type IntegrationRecord,
  type IntegrationStore,
  iconFilePath,
  inspectSystemIntegration,
  isOwnedBySelf,
  isSafeAppImagePath,
  isSafeDesktopId,
  OWNERSHIP_ID_KEY,
  OWNERSHIP_MARKER_KEY,
  OWNERSHIP_MARKER_VALUE,
  parseDesktopEntry,
  parseExecValue,
  parseIntegrationRecord,
  removeDesktopIdFromMimeApps,
  removeSystemIntegration,
  resolveXdgDataHome,
  runStartupIntegration,
  serializeExecValue,
  sha256Hex,
  UnsafeAppImagePathError,
} from './appimage-integration'

// ── Test doubles ────────────────────────────────────────

// A fixed installId so tests can build files that our ownership check accepts.
const TEST_INSTALL_ID = 'test-install-id-0001'

function ownedEntry(
  appImagePath: string,
  installId: string = TEST_INSTALL_ID
): string {
  return buildDesktopEntry({ appImagePath, installId })
}

function createFakeStore(
  initial?: Partial<IntegrationRecord>
): IntegrationStore & {
  record: IntegrationRecord
} {
  const state = {
    record: parseIntegrationRecord({
      ...DEFAULT_INTEGRATION_RECORD,
      ...initial,
    }),
  }
  return {
    get record() {
      return state.record
    },
    load: vi.fn(async () => state.record),
    save: vi.fn(async (next: IntegrationRecord) => {
      state.record = next
    }),
  }
}

function createFakeFs(
  seed: Record<string, string> = {},
  // Paths that "exist" but throw a non-ENOENT error on read (e.g. permission
  // denied) — used to prove we never clobber an unreadable foreign file.
  unreadable: Set<string> = new Set(),
  onWrite?: (filePath: string, data: string) => void
): IntegrationFs & {
  files: Map<string, string>
} {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    writeText: vi.fn(async (p: string, data: string) => {
      files.set(p, data)
      onWrite?.(p, data)
    }),
    readText: vi.fn(async (p: string) => {
      if (unreadable.has(p))
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const value = files.get(p)
      if (value === undefined) throw new Error(`ENOENT: ${p}`)
      return value
    }),
    readBytes: vi.fn(async (p: string) => {
      if (unreadable.has(p))
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const value = files.get(p)
      if (value === undefined) throw new Error(`ENOENT: ${p}`)
      return new TextEncoder().encode(value)
    }),
    remove: vi.fn(async (p: string) => {
      files.delete(p)
    }),
    mkdirp: vi.fn(async () => {}),
    copyFile: vi.fn(async (src: string, dest: string) => {
      const value = files.get(src)
      if (value === undefined) throw new Error(`ENOENT: ${src}`)
      files.set(dest, value)
    }),
  }
}

function syncFakeDefaultsFromMimeApps(xdg: FakeXdg, content: string): void {
  for (const mime of [
    'x-scheme-handler/motrix',
    'application/x-bittorrent',
    'x-scheme-handler/magnet',
  ]) {
    const escaped = mime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const value = new RegExp(`^${escaped}=([^;]+);`, 'mu').exec(content)?.[1]
    if (value) xdg.defaults.set(mime, value)
    else xdg.defaults.delete(mime)
  }
}

interface FakeXdg {
  runCommand: (
    command: string,
    args: string[]
  ) => Promise<{
    code: number
    stdout: string
    stderr: string
  }>
  defaults: Map<string, string>
  calls: Array<{ command: string; args: string[] }>
}

function createFakeXdg(
  initialDefaults: Record<string, string> = {},
  // `setIsNoop`: the `default` command reports success but does not change the
  // stored default (models a silent desktop-policy refusal). `setReturnsCode`:
  // the `default` command fails with this exit code (and does not apply).
  // `queryReturnsCode`: the `query default` command fails with this exit code
  // (models a missing/timed-out `xdg-mime`).
  opts: {
    setIsNoop?: boolean
    setReturnsCode?: number
    queryReturnsCode?: number
  } = {}
): FakeXdg {
  const defaults = new Map<string, string>(Object.entries(initialDefaults))
  const calls: FakeXdg['calls'] = []
  return {
    defaults,
    calls,
    runCommand: vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (
        command === 'xdg-mime' &&
        args[0] === 'query' &&
        args[1] === 'default'
      ) {
        const code = opts.queryReturnsCode ?? 0
        return {
          code,
          stdout: code === 0 ? `${defaults.get(args[2]) ?? ''}\n` : '',
          stderr: '',
        }
      }
      if (command === 'xdg-mime' && args[0] === 'default') {
        const code = opts.setReturnsCode ?? 0
        // args: ['default', '<desktop-id>', '<mime>...']
        if (code === 0 && !opts.setIsNoop) {
          for (const mime of args.slice(2)) defaults.set(mime, args[1])
        }
        return { code, stdout: '', stderr: '' }
      }
      if (command === 'update-desktop-database') {
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }),
  }
}

const APPIMAGE = '/home/u/Applications/Motrix-2.0.0-x86_64.AppImage'
const HOME = '/home/u'
const ICON_SOURCE = '/opt/resources/icons/motrix-appimage-256.png'

function baseDeps(overrides: {
  store: IntegrationStore
  fs: IntegrationFs
  xdg: FakeXdg
  env?: NodeJS.ProcessEnv
  appImagePath?: string
  getMagnetEnabled?: () => boolean
  prompt?: () => Promise<boolean>
}) {
  return {
    appImagePath: overrides.appImagePath ?? APPIMAGE,
    env: overrides.env ?? {},
    homedir: HOME,
    iconSourcePath: ICON_SOURCE,
    store: overrides.store,
    fs: overrides.fs,
    runCommand: overrides.xdg.runCommand,
    getMagnetEnabled: overrides.getMagnetEnabled ?? (() => false),
    prompt: overrides.prompt ?? (async () => true),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

// ── Safety validators ───────────────────────────────────

describe('isSafeAppImagePath', () => {
  it('accepts ordinary absolute paths, including spaces and unicode', () => {
    expect(isSafeAppImagePath('/home/u/Motrix.AppImage')).toBe(true)
    expect(isSafeAppImagePath('/home/u/My Apps/Motrix.AppImage')).toBe(true)
    expect(isSafeAppImagePath('/home/u/下载/Motrix.AppImage')).toBe(true)
  })

  it('rejects LF, CR, NUL and other control characters', () => {
    expect(isSafeAppImagePath('/tmp/A\nExec=sh -c id\n#/x.AppImage')).toBe(
      false
    )
    expect(isSafeAppImagePath('/tmp/a\rb')).toBe(false)
    expect(isSafeAppImagePath('/tmp/a\x00b')).toBe(false)
    expect(isSafeAppImagePath('/tmp/a\x7fb')).toBe(false)
    expect(isSafeAppImagePath('')).toBe(false)
  })
})

describe('isSafeDesktopId', () => {
  it('accepts a flat *.desktop basename', () => {
    expect(isSafeDesktopId('motrix-appimage.desktop')).toBe(true)
    expect(isSafeDesktopId('org.mozilla.firefox.desktop')).toBe(true)
  })

  it('rejects traversal, separators, leading dash, and non-desktop ids', () => {
    expect(isSafeDesktopId('../../etc/passwd.desktop')).toBe(false)
    expect(isSafeDesktopId('a/b.desktop')).toBe(false)
    expect(isSafeDesktopId('-x.desktop')).toBe(false)
    expect(isSafeDesktopId('firefox')).toBe(false)
    expect(isSafeDesktopId('has space.desktop')).toBe(false)
    expect(isSafeDesktopId('')).toBe(false)
  })
})

describe('removeDesktopIdFromMimeApps', () => {
  it('removes only the owned default and preserves fallback handlers', () => {
    const source = [
      '# keep',
      '[Default Applications]',
      'x-scheme-handler/magnet=motrix-appimage.desktop;firefox.desktop;',
      'application/pdf=org.pwmt.zathura.desktop;',
      '',
      '[Added Associations]',
      'x-scheme-handler/magnet=motrix-appimage.desktop;',
      '',
    ].join('\n')

    expect(
      removeDesktopIdFromMimeApps(
        source,
        'x-scheme-handler/magnet',
        DESKTOP_ENTRY_ID
      )
    ).toEqual({
      changed: true,
      content: source.replace(
        'x-scheme-handler/magnet=motrix-appimage.desktop;firefox.desktop;',
        'x-scheme-handler/magnet=firefox.desktop;'
      ),
    })
  })
})

// ── Exec serialization ──────────────────────────────────

describe('serializeExecValue / parseExecValue', () => {
  it('leaves a simple path unquoted and round-trips', () => {
    expect(serializeExecValue(['/usr/bin/motrix'])).toBe('/usr/bin/motrix')
    expect(parseExecValue('/usr/bin/motrix')).toEqual(['/usr/bin/motrix'])
  })

  it('quotes and round-trips paths with spaces, quotes, backtick, $ and backslash', () => {
    const cases = [
      '/home/user name/Motrix.AppImage',
      '/path/with"quote/app',
      '/path/with`backtick/app',
      '/path/with$dollar/app',
      '/path/with\\backslash/app',
      '/weird/ & ; | > < ~ ( ) # * ?/app',
    ]
    for (const value of cases) {
      const serialized = serializeExecValue([value])
      expect(parseExecValue(serialized)).toEqual([value])
    }
  })

  it('escapes a literal percent as %% and restores it', () => {
    const serialized = serializeExecValue(['/tmp/50%off/app'])
    expect(serialized).toContain('%%')
    expect(serialized).not.toMatch(/[^%]%[^%]/)
    expect(parseExecValue(serialized)).toEqual(['/tmp/50%off/app'])
  })

  it('doubles backslashes at the string-value layer for a quoted arg', () => {
    // FDO note: a literal backslash inside a quoted argument needs four
    // successive backslashes in the desktop-entry file.
    const serialized = serializeExecValue(['/a\\b'])
    expect(serialized).toBe('"/a\\\\\\\\b"')
  })

  it('round-trips a multi-argument Exec', () => {
    const argv = ['/home/u/My Apps/Motrix.AppImage', '--flag', 'a$b']
    expect(parseExecValue(serializeExecValue(argv))).toEqual(argv)
  })
})

// ── XDG resolver ────────────────────────────────────────

describe('resolveXdgDataHome', () => {
  it('uses an absolute XDG_DATA_HOME', () => {
    expect(resolveXdgDataHome({ XDG_DATA_HOME: '/custom/share' }, HOME)).toBe(
      '/custom/share'
    )
  })

  it('ignores a relative XDG_DATA_HOME and falls back to ~/.local/share', () => {
    expect(resolveXdgDataHome({ XDG_DATA_HOME: 'relative/share' }, HOME)).toBe(
      '/home/u/.local/share'
    )
  })

  it('falls back when XDG_DATA_HOME is unset or empty', () => {
    expect(resolveXdgDataHome({}, HOME)).toBe('/home/u/.local/share')
    expect(resolveXdgDataHome({ XDG_DATA_HOME: '' }, HOME)).toBe(
      '/home/u/.local/share'
    )
  })

  it('derives desktop and icon paths under the data home', () => {
    const dataHome = '/custom/share'
    expect(desktopEntryFilePath(dataHome)).toBe(
      '/custom/share/applications/motrix-appimage.desktop'
    )
    expect(iconFilePath(dataHome)).toBe(
      '/custom/share/icons/hicolor/256x256/apps/motrix-appimage.png'
    )
  })
})

// ── Desktop entry ───────────────────────────────────────

describe('buildDesktopEntry', () => {
  const content = ownedEntry(APPIMAGE)

  it('declares all three MimeType handlers', () => {
    const entry = parseDesktopEntry(content)
    const mime = entry.get('MimeType') ?? ''
    expect(mime).toContain('application/x-bittorrent')
    expect(mime).toContain('x-scheme-handler/magnet')
    expect(mime).toContain('x-scheme-handler/motrix')
  })

  it('carries the ownership marker, install id, icon, and window class', () => {
    const entry = parseDesktopEntry(content)
    expect(entry.get(OWNERSHIP_MARKER_KEY)).toBe(OWNERSHIP_MARKER_VALUE)
    expect(entry.get(OWNERSHIP_ID_KEY)).toBe(TEST_INSTALL_ID)
    expect(entry.get('Icon')).toBe('motrix-appimage')
    expect(entry.get('StartupWMClass')).toBe('Motrix')
    expect(isOwnedBySelf(entry, TEST_INSTALL_ID)).toBe(true)
  })

  it('points Exec at the AppImage and appends the %U field code literally', () => {
    const entry = parseDesktopEntry(content)
    const exec = entry.get('Exec') ?? ''
    expect(exec.endsWith(' %U')).toBe(true)
    expect(execTargetsAppImage(exec, APPIMAGE)).toBe(true)
  })

  it('escapes an AppImage path that contains a space', () => {
    const spaced = '/home/u/My Apps/Motrix.AppImage'
    const entry = parseDesktopEntry(ownedEntry(spaced))
    expect(execTargetsAppImage(entry.get('Exec') ?? '', spaced)).toBe(true)
  })

  it('refuses to serialize a path with control characters (Exec injection)', () => {
    const injected = '/tmp/A\nExec=sh -c id\n#/Motrix.AppImage'
    expect(() =>
      buildDesktopEntry({ appImagePath: injected, installId: TEST_INSTALL_ID })
    ).toThrow(UnsafeAppImagePathError)
  })

  it('refuses to serialize an install id with control characters (line injection)', () => {
    expect(() =>
      buildDesktopEntry({
        appImagePath: APPIMAGE,
        installId: 'id\nExec=sh -c id',
      })
    ).toThrow(UnsafeAppImagePathError)
  })
})

// ── Ownership by install id (not just the marker) ───────

describe('isOwnedBySelf', () => {
  it('requires the marker AND a matching install id', () => {
    const entry = parseDesktopEntry(ownedEntry(APPIMAGE, 'id-A'))
    expect(isOwnedBySelf(entry, 'id-A')).toBe(true)
    // A foreign file that copied our marker but has a different / no id is not ours.
    expect(isOwnedBySelf(entry, 'id-B')).toBe(false)
    expect(isOwnedBySelf(entry, null)).toBe(false)
    const noMarker = parseDesktopEntry(
      `[Desktop Entry]\nExec="${APPIMAGE}" %U\n`
    )
    expect(isOwnedBySelf(noMarker, 'id-A')).toBe(false)
  })
})

describe('classifyDesktopFile', () => {
  it('returns ok for our current file, drift for our stale file', () => {
    expect(
      classifyDesktopFile(ownedEntry(APPIMAGE), APPIMAGE, TEST_INSTALL_ID)
    ).toBe('ok')
    expect(
      classifyDesktopFile(
        ownedEntry('/old/Motrix.AppImage'),
        APPIMAGE,
        TEST_INSTALL_ID
      )
    ).toBe('drift')
  })

  it('returns conflict for a foreign file (missing or mismatched id)', () => {
    // marker copied but different id
    expect(
      classifyDesktopFile(
        ownedEntry(APPIMAGE, 'someone-else'),
        APPIMAGE,
        TEST_INSTALL_ID
      )
    ).toBe('conflict')
    // no marker at all
    expect(
      classifyDesktopFile(
        `[Desktop Entry]\nExec="${APPIMAGE}" %U\n`,
        APPIMAGE,
        TEST_INSTALL_ID
      )
    ).toBe('conflict')
  })
})

// ── External-owner classification ───────────────────────

const EXTERNAL_ENTRY = `[Desktop Entry]\nType=Application\nExec="${APPIMAGE}" %U\n`

describe('classifyDefaultHandler', () => {
  it('classifies our own marked desktop file as self', () => {
    const entry = parseDesktopEntry(ownedEntry(APPIMAGE))
    expect(
      classifyDefaultHandler({
        handlerId: DESKTOP_ENTRY_ID,
        resolvedEntry: entry,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('self')
  })

  it('classifies a third-party handler that launches this AppImage as external', () => {
    const entry = parseDesktopEntry(EXTERNAL_ENTRY)
    expect(
      classifyDefaultHandler({
        handlerId: 'some-launcher.desktop',
        resolvedEntry: entry,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('external')
  })

  it('does not classify a deb Motrix or stale entry as external', () => {
    const deb = parseDesktopEntry(
      '[Desktop Entry]\nType=Application\nExec=/opt/Motrix/motrix %U\n'
    )
    expect(
      classifyDefaultHandler({
        handlerId: 'motrix.desktop',
        resolvedEntry: deb,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
    expect(
      classifyDefaultHandler({
        handlerId: null,
        resolvedEntry: null,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
  })

  it('does not treat a handler that merely lists the path as an argument as external', () => {
    // argv[0] is /usr/bin/echo, the AppImage is only a parameter.
    const echo = parseDesktopEntry(
      `[Desktop Entry]\nType=Application\nExec=/usr/bin/echo ${APPIMAGE} %U\n`
    )
    expect(
      classifyDefaultHandler({
        handlerId: 'echo.desktop',
        resolvedEntry: echo,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
  })

  it('rejects a non-Application, hidden, or unsafe-id handler', () => {
    const notApp = parseDesktopEntry(`[Desktop Entry]\nExec="${APPIMAGE}" %U\n`)
    expect(
      classifyDefaultHandler({
        handlerId: 'x.desktop',
        resolvedEntry: notApp,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
    const hidden = parseDesktopEntry(
      `[Desktop Entry]\nType=Application\nHidden=true\nExec="${APPIMAGE}" %U\n`
    )
    expect(
      classifyDefaultHandler({
        handlerId: 'x.desktop',
        resolvedEntry: hidden,
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
    expect(
      classifyDefaultHandler({
        handlerId: '../../evil.desktop',
        resolvedEntry: parseDesktopEntry(EXTERNAL_ENTRY),
        appImagePath: APPIMAGE,
        installId: TEST_INSTALL_ID,
      })
    ).toBe('none')
  })
})

// ── Persisted record schema ─────────────────────────────

describe('parseIntegrationRecord', () => {
  it('returns the default record for junk input', () => {
    expect(parseIntegrationRecord(null)).toEqual(DEFAULT_INTEGRATION_RECORD)
    expect(parseIntegrationRecord('nope')).toEqual(DEFAULT_INTEGRATION_RECORD)
  })

  it('coerces invalid fields to safe defaults but keeps valid ones', () => {
    const parsed = parseIntegrationRecord({
      decision: 'accepted',
      owner: 'weird',
      desktopId: 'motrix-appimage.desktop',
      status: 'nope',
      nmConsent: 'accepted',
      installId: 'keep-me',
    })
    expect(parsed.decision).toBe('accepted')
    expect(parsed.owner).toBe(null)
    expect(parsed.desktopId).toBe('motrix-appimage.desktop')
    expect(parsed.status).toBe(null)
    expect(parsed.nmConsent).toBe('accepted')
    expect(parsed.installId).toBe('keep-me')
    expect(parsed.iconSha256).toBe(null)
  })
})

// ── Startup state machine ───────────────────────────────

describe('runStartupIntegration', () => {
  it('does nothing when the decision is declined', async () => {
    const store = createFakeStore({ decision: 'declined' })
    const fs = createFakeFs()
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(fs.copyFile).not.toHaveBeenCalled()
    expect(xdg.calls).toHaveLength(0)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('never writes or repairs when a still-present external owner is accepted', async () => {
    const dataHome = '/home/u/.local/share'
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'external',
      desktopId: 'other.desktop',
    })
    const fs = createFakeFs({
      [`${dataHome}/applications/other.desktop`]: EXTERNAL_ENTRY,
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': 'other.desktop' })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(store.record.owner).toBe('external')
  })

  it('re-detects when a recorded external owner has vanished', async () => {
    // External integration recorded, but the default handler is now gone.
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'external',
      desktopId: 'other.desktop',
    })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg() // no default handler → external is gone
    // Prompt refuses, so we should end up declined rather than stuck healthy.
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, prompt: async () => false })
    )
    expect(store.record.decision).toBe('declined')
    expect(store.record.owner).toBe(null)
  })

  it('records an external owner when a verified third-party handler exists', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const dataHome = '/home/u/.local/share'
    const fs = createFakeFs({
      [`${dataHome}/applications/thirdparty.desktop`]: EXTERNAL_ENTRY,
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': 'thirdparty.desktop',
    })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(store.record.decision).toBe('accepted')
    expect(store.record.owner).toBe('external')
    expect(store.record.desktopId).toBe('thirdparty.desktop')
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('prompts and installs self integration on accept, in transactional order', async () => {
    const dataHome0 = '/home/u/.local/share'
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({
      [ICON_SOURCE]: 'PNGDATA',
      // A real prior handler file, so it is eligible to be recorded as the
      // previous default (a phantom id would not be).
      [`${dataHome0}/applications/firefox.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/firefox %u\n',
      [`${dataHome0}/applications/transmission.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/transmission %f\n',
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': 'firefox.desktop',
      'application/x-bittorrent': 'transmission.desktop',
    })
    const prompt = vi.fn(async () => true)
    await runStartupIntegration(baseDeps({ store, fs, xdg, prompt }))

    expect(prompt).toHaveBeenCalledOnce()
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    // desktop file + icon written
    expect(fs.files.get(desktopPath)).toContain('X-Motrix-Integration=appimage')
    expect(fs.files.get(iconPath)).toBe('PNGDATA')

    // previous handler recorded before override
    expect(store.record.previousSchemeHandler).toBe('firefox.desktop')
    expect(store.record.previousTorrentHandler).toBe('transmission.desktop')
    // final state healthy, self-owned, with a persisted id + icon hash
    expect(store.record.decision).toBe('accepted')
    expect(store.record.owner).toBe('self')
    expect(store.record.status).toBe('healthy')
    expect(store.record.desktopId).toBe(DESKTOP_ENTRY_ID)
    expect(store.record.installId).toBeTruthy()
    expect(store.record.iconSha256).toBe(sha256Hex('PNGDATA'))

    // the on-disk file is owned by the persisted install id
    expect(
      isOwnedBySelf(
        parseDesktopEntry(fs.files.get(desktopPath) ?? ''),
        store.record.installId
      )
    ).toBe(true)

    // ordering: update-desktop-database precedes the default assignment
    const dbIndex = xdg.calls.findIndex(
      (c) => c.command === 'update-desktop-database'
    )
    const setIndex = xdg.calls.findIndex(
      (c) => c.command === 'xdg-mime' && c.args[0] === 'default'
    )
    expect(dbIndex).toBeGreaterThanOrEqual(0)
    expect(setIndex).toBeGreaterThan(dbIndex)
    // default was verified by re-query afterwards
    expect(xdg.defaults.get('x-scheme-handler/motrix')).toBe(DESKTOP_ENTRY_ID)
    expect(xdg.defaults.get('application/x-bittorrent')).toBe(DESKTOP_ENTRY_ID)
  })

  it('fails closed without writing when the AppImage path has control chars', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(
      baseDeps({
        store,
        fs,
        xdg,
        appImagePath: '/tmp/A\nExec=sh -c id\n#/Motrix.AppImage',
      })
    )
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(store.record.status).toBe('failed')
  })

  it('does not overwrite a foreign file occupying our desktop path (first install)', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const foreign =
      '[Desktop Entry]\nType=Application\nName=NotUs\nExec=/x %U\n'
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({
      [desktopPath]: foreign,
      [ICON_SOURCE]: 'PNGDATA',
    })
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    // untouched
    expect(fs.files.get(desktopPath)).toBe(foreign)
    expect(store.record.status).toBe('failed')
  })

  it('does not overwrite an existing-but-unreadable foreign desktop file', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({ decision: 'unset' })
    // The desktop path exists but cannot be read — must be treated as a foreign
    // file (conflict), never assumed absent and overwritten.
    const fs = createFakeFs(
      { [ICON_SOURCE]: 'PNGDATA', [desktopPath]: 'FOREIGN-UNREADABLE' },
      new Set([desktopPath])
    )
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.get(desktopPath)).toBe('FOREIGN-UNREADABLE')
    expect(store.record.status).toBe('failed')
  })

  it('does not overwrite a foreign icon squatting our icon path', async () => {
    const dataHome = '/home/u/.local/share'
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({
      [ICON_SOURCE]: 'PNGDATA',
      [iconPath]: 'FOREIGN-ICON',
    })
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    // foreign icon preserved; not overwritten with our bytes
    expect(fs.files.get(iconPath)).toBe('FOREIGN-ICON')
    // and its hash was never recorded as ours
    expect(store.record.iconSha256).not.toBe(sha256Hex('PNGDATA'))
  })

  it('does not overwrite an existing-but-unreadable foreign icon', async () => {
    const dataHome = '/home/u/.local/share'
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({ decision: 'unset' })
    // Icon path exists but cannot be read (permission denied), so we must not
    // assume it is absent and clobber it.
    const fs = createFakeFs(
      { [ICON_SOURCE]: 'PNGDATA', [iconPath]: 'FOREIGN' },
      new Set([iconPath])
    )
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.get(iconPath)).toBe('FOREIGN')
    expect(fs.copyFile).not.toHaveBeenCalled()
  })

  it('does not record a phantom previous handler that has no desktop file', async () => {
    const store = createFakeStore({ decision: 'unset' })
    // The current default points at an id with no backing desktop file (e.g. a
    // handler a prior Electron registration left dangling). It must not be
    // captured as the previous handler, or removal would restore a dead default.
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': 'ghost.desktop' })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(store.record.previousSchemeHandler).toBe(null)
  })

  it('aborts install without touching defaults when the current default cannot be queried', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    // The query command fails, so we cannot learn the user's real handler —
    // integration must fail closed rather than persist null and overwrite it.
    const xdg = createFakeXdg({}, { queryReturnsCode: 1 })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(store.record.status).toBe('failed')
    expect(fs.writeText).not.toHaveBeenCalled()
    // no default was set
    expect(
      xdg.calls.some((c) => c.command === 'xdg-mime' && c.args[0] === 'default')
    ).toBe(false)
  })

  it('captures and persists the overwritten magnet handler before claiming it', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [ICON_SOURCE]: 'PNGDATA',
      // A real prior magnet handler we are about to override.
      [`${dataHome}/applications/qbittorrent.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/qbittorrent %u\n',
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'x-scheme-handler/magnet': 'qbittorrent.desktop',
    })
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => true })
    )
    // The prior handler is captured as previous, and persisted BEFORE the
    // magnet default is overridden.
    expect(store.record.previousMagnetHandler).toBe('qbittorrent.desktop')
    const saveWithPrev = vi
      .mocked(store.save)
      .mock.calls.findIndex(
        (c) => c[0]?.previousMagnetHandler === 'qbittorrent.desktop'
      )
    const magnetSetCallIndex = xdg.calls.findIndex(
      (c) =>
        c.command === 'xdg-mime' &&
        c.args[0] === 'default' &&
        c.args[2] === 'x-scheme-handler/magnet'
    )
    expect(saveWithPrev).toBeGreaterThanOrEqual(0)
    expect(magnetSetCallIndex).toBeGreaterThanOrEqual(0)
    const saveOrder = vi.mocked(store.save).mock.invocationCallOrder[
      saveWithPrev
    ]
    const setOrder = vi.mocked(xdg.runCommand).mock.invocationCallOrder[
      magnetSetCallIndex
    ]
    expect(saveOrder).toBeLessThan(setOrder)
    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe(DESKTOP_ENTRY_ID)
  })

  it('claims the magnet default at startup when the setting is enabled (AppImage convergence)', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [ICON_SOURCE]: 'PNGDATA',
    })
    // Desktop is current (ok), but magnet default is not ours yet.
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => true })
    )
    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe(DESKTOP_ENTRY_ID)
  })

  it('hands the magnet default back at startup when the setting is disabled', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousMagnetHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [ICON_SOURCE]: 'PNGDATA',
      // The prior handler must still resolve for restore to proceed.
      [`${dataHome}/applications/firefox.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/firefox %u\n',
    })
    // Both defaults currently ours; magnet setting is now off → magnet reverts.
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'x-scheme-handler/magnet': DESKTOP_ENTRY_ID,
    })
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => false })
    )
    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe('firefox.desktop')
    // the scheme default stays ours
    expect(xdg.defaults.get('x-scheme-handler/motrix')).toBe(DESKTOP_ENTRY_ID)
  })

  it('clears an owned magnet default when there was no previous handler', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const mimeAppsPath = '/home/u/.config/mimeapps.list'
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'x-scheme-handler/magnet': DESKTOP_ENTRY_ID,
    })
    const fs = createFakeFs(
      {
        [desktopPath]: ownedEntry(APPIMAGE),
        [ICON_SOURCE]: 'PNGDATA',
        [mimeAppsPath]:
          '[Default Applications]\nx-scheme-handler/magnet=motrix-appimage.desktop;\n',
      },
      new Set(),
      (filePath, content) => {
        if (filePath === mimeAppsPath) {
          syncFakeDefaultsFromMimeApps(xdg, content)
          xdg.defaults.set('x-scheme-handler/motrix', DESKTOP_ENTRY_ID)
        }
      }
    )

    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => false })
    )

    expect(xdg.defaults.has('x-scheme-handler/magnet')).toBe(false)
    expect(store.record.status).toBe('healthy')
    expect(fs.files.get(mimeAppsPath)).not.toContain(
      'x-scheme-handler/magnet=motrix-appimage.desktop;'
    )
  })

  it('marks reconciliation failed when an owned magnet default cannot be cleared', async () => {
    const dataHome = '/home/u/.local/share'
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({
      [desktopEntryFilePath(dataHome)]: ownedEntry(APPIMAGE),
      [ICON_SOURCE]: 'PNGDATA',
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'x-scheme-handler/magnet': DESKTOP_ENTRY_ID,
    })

    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => false })
    )

    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe(DESKTOP_ENTRY_ID)
    expect(store.record.status).toBe('failed')
  })

  it('persists the install id before writing files (crash recovery)', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    // The first store.save carrying a non-null installId must happen before the
    // desktop file is ever written, so a crash cannot orphan our own file.
    const save = vi.mocked(store.save)
    const write = vi.mocked(fs.writeText)
    const firstIdSaveIndex = save.mock.calls.findIndex(
      (c) => c[0]?.installId != null
    )
    expect(firstIdSaveIndex).toBeGreaterThanOrEqual(0)
    expect(save.mock.invocationCallOrder[firstIdSaveIndex]).toBeLessThan(
      write.mock.invocationCallOrder[0]
    )
  })

  it('regenerates an unsafe persisted install id instead of writing it', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'failed',
      desktopId: DESKTOP_ENTRY_ID,
      installId: 'bad\nExec=sh -c id',
    })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    const content = fs.files.get(desktopPath) ?? ''
    // The written file must not contain the injected line, and must be healthy.
    expect(content).not.toContain('Exec=sh -c id')
    expect(store.record.installId).not.toContain('\n')
    expect(store.record.status).toBe('healthy')
  })

  it('sets the magnet default only when the magnet setting is enabled', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => true })
    )
    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe(DESKTOP_ENTRY_ID)
  })

  it('leaves the magnet default untouched when the setting is disabled', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg({ 'x-scheme-handler/magnet': 'other.desktop' })
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, getMagnetEnabled: () => false })
    )
    expect(xdg.defaults.get('x-scheme-handler/magnet')).toBe('other.desktop')
  })

  it('records status failed when the default cannot be verified', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg({}, { setIsNoop: true })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(store.record.status).toBe('failed')
  })

  it('records declined without writing when the prompt is refused', async () => {
    const store = createFakeStore({ decision: 'unset' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(
      baseDeps({ store, fs, xdg, prompt: async () => false })
    )
    expect(store.record.decision).toBe('declined')
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('silently rewrites a self-owned desktop file whose Exec drifted', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const stale = ownedEntry('/old/Motrix.AppImage')
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({ [desktopPath]: stale, [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(
      execTargetsAppImage(
        parseDesktopEntry(fs.files.get(desktopPath) ?? '').get('Exec') ?? '',
        APPIMAGE
      )
    ).toBe(true)
  })

  it('does not overwrite a foreign file during self-heal (ownership conflict)', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    // our marker but a DIFFERENT install id → not ours.
    const foreign = ownedEntry(APPIMAGE, 'someone-else')
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({
      [desktopPath]: foreign,
      [ICON_SOURCE]: 'PNGDATA',
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.get(desktopPath)).toBe(foreign) // untouched
    expect(store.record.status).toBe('failed')
  })

  it('does not rewrite a self-owned desktop file that is already current', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const current = ownedEntry(APPIMAGE)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({
      [desktopPath]: current,
      [ICON_SOURCE]: 'PNGDATA',
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('retries the full install when a self-owned record is marked failed', async () => {
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'failed',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
    })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await runStartupIntegration(baseDeps({ store, fs, xdg }))
    const dataHome = '/home/u/.local/share'
    expect(fs.files.get(desktopEntryFilePath(dataHome))).toContain(
      'X-Motrix-Integration=appimage'
    )
    expect(store.record.status).toBe('healthy')
  })
})

// ── Manual enable / removal ─────────────────────────────

describe('enableSystemIntegration', () => {
  it('installs self integration regardless of a prior declined decision', async () => {
    const store = createFakeStore({ decision: 'declined' })
    const fs = createFakeFs({ [ICON_SOURCE]: 'PNGDATA' })
    const xdg = createFakeXdg()
    await enableSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(store.record.decision).toBe('accepted')
    expect(store.record.owner).toBe('self')
  })
})

describe('inspectSystemIntegration', () => {
  it('downgrades a stale persisted healthy state without mutating the store', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      iconSha256: sha256Hex('PNGDATA'),
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [iconPath]: 'PNGDATA',
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'application/x-bittorrent': DESKTOP_ENTRY_ID,
    })
    const deps = baseDeps({ store, fs, xdg, getMagnetEnabled: () => false })

    await expect(inspectSystemIntegration(deps)).resolves.toMatchObject({
      status: 'healthy',
    })
    fs.files.delete(desktopPath)
    await expect(inspectSystemIntegration(deps)).resolves.toMatchObject({
      status: 'failed',
    })
    expect(store.record.status).toBe('healthy')
    expect(store.save).not.toHaveBeenCalled()
  })
})

describe('removeSystemIntegration', () => {
  it('is a no-op for an externally-owned integration', async () => {
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'external',
      desktopId: 'motrix.desktop',
      status: 'healthy',
    })
    const fs = createFakeFs()
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': 'motrix.desktop' })
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(next.decision).toBe('accepted')
    expect(next.owner).toBe('external')
    expect(store.record.owner).toBe('external')
    expect(xdg.calls).toEqual([])
    expect(fs.remove).not.toHaveBeenCalled()
  })

  it('reverses the install: deletes owned files, restores default, sets declined', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      iconSha256: sha256Hex('PNGDATA'),
      previousSchemeHandler: 'firefox.desktop',
      previousTorrentHandler: 'transmission.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [iconPath]: 'PNGDATA',
      // The recorded previous handler must still resolve for restore to run.
      [`${dataHome}/applications/firefox.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/firefox %u\n',
      [`${dataHome}/applications/transmission.desktop`]:
        '[Desktop Entry]\nType=Application\nExec=/usr/bin/transmission %f\n',
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'application/x-bittorrent': DESKTOP_ENTRY_ID,
    })
    await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(desktopPath)).toBe(false)
    expect(fs.files.has(iconPath)).toBe(false)
    expect(xdg.defaults.get('x-scheme-handler/motrix')).toBe('firefox.desktop')
    expect(xdg.defaults.get('application/x-bittorrent')).toBe(
      'transmission.desktop'
    )
    expect(store.record.decision).toBe('declined')
    expect(store.record.owner).toBe(null)
  })

  it('removes a first integration when none of the defaults had a prior handler', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    const mimeAppsPath = '/home/u/.config/mimeapps.list'
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      iconSha256: sha256Hex('PNGDATA'),
    })
    const xdg = createFakeXdg({
      'x-scheme-handler/motrix': DESKTOP_ENTRY_ID,
      'application/x-bittorrent': DESKTOP_ENTRY_ID,
      'x-scheme-handler/magnet': DESKTOP_ENTRY_ID,
    })
    const fs = createFakeFs(
      {
        [desktopPath]: ownedEntry(APPIMAGE),
        [iconPath]: 'PNGDATA',
        [mimeAppsPath]: [
          '[Default Applications]',
          'x-scheme-handler/motrix=motrix-appimage.desktop;',
          'application/x-bittorrent=motrix-appimage.desktop;',
          'x-scheme-handler/magnet=motrix-appimage.desktop;',
          '',
        ].join('\n'),
      },
      new Set(),
      (filePath, content) => {
        if (filePath === mimeAppsPath) {
          syncFakeDefaultsFromMimeApps(xdg, content)
        }
      }
    )

    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))

    expect(next.decision).toBe('declined')
    expect(fs.files.has(desktopPath)).toBe(false)
    expect(fs.files.has(iconPath)).toBe(false)
    expect([...xdg.defaults.values()]).not.toContain(DESKTOP_ENTRY_ID)
  })

  it('does not restore the default when it is no longer owned by Motrix', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousSchemeHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': 'chromium.desktop' })
    await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    // still chromium — we must not clobber a handler the user re-pointed
    expect(xdg.defaults.get('x-scheme-handler/motrix')).toBe('chromium.desktop')
  })

  it('only deletes a desktop file that is verifiably ours', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    // marker copied but a different install id → foreign, must be preserved.
    const foreign = ownedEntry(APPIMAGE, 'someone-else')
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousSchemeHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({ [desktopPath]: foreign })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': 'firefox.desktop' })
    await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(desktopPath)).toBe(true)
  })

  it('does not delete an icon whose bytes no longer match what we installed', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      iconSha256: sha256Hex('ORIGINAL-ICON'),
      previousSchemeHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [iconPath]: 'USER-REPLACED-THIS',
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(iconPath)).toBe(true) // preserved
  })

  it('keeps the desktop file and stays failed when the default cannot be restored', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const iconPath = iconFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      iconSha256: sha256Hex('PNGDATA'),
      previousSchemeHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      [iconPath]: 'PNGDATA',
    })
    // The `default` command fails, so the restore cannot be verified.
    const xdg = createFakeXdg(
      { 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID },
      { setReturnsCode: 1 }
    )
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    // desktop kept so the default is not left dangling
    expect(fs.files.has(desktopPath)).toBe(true)
    expect(next.status).toBe('failed')
    expect(next.decision).toBe('accepted')
  })

  it('keeps the desktop file when the current default cannot be queried', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousSchemeHandler: 'firefox.desktop',
    })
    const fs = createFakeFs({ [desktopPath]: ownedEntry(APPIMAGE) })
    // The `query default` command itself fails — we cannot confirm the default
    // is no longer ours, so deletion must be blocked.
    const xdg = createFakeXdg(
      { 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID },
      { queryReturnsCode: 1 }
    )
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(desktopPath)).toBe(true)
    expect(next.status).toBe('failed')
  })

  it('keeps the desktop file when the recorded previous handler no longer resolves', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      // Recorded as previous, but the desktop file has since been uninstalled.
      previousSchemeHandler: 'gone.desktop',
    })
    const fs = createFakeFs({ [desktopPath]: ownedEntry(APPIMAGE) })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    // must not restore to a dead handler, and must not delete our own desktop
    expect(fs.files.has(desktopPath)).toBe(true)
    expect(next.status).toBe('failed')
  })

  it('keeps the desktop file when the previous handler exists but is not launchable', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousSchemeHandler: 'broken.desktop',
    })
    const fs = createFakeFs({
      [desktopPath]: ownedEntry(APPIMAGE),
      // Present but disabled / no usable Exec → must not be restored to.
      [`${dataHome}/applications/broken.desktop`]:
        '[Desktop Entry]\nType=Application\nHidden=true\nExec=/x\n',
    })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(desktopPath)).toBe(true)
    expect(next.status).toBe('failed')
  })

  it('keeps the desktop file when no editable file contains the owned default', async () => {
    const dataHome = '/home/u/.local/share'
    const desktopPath = desktopEntryFilePath(dataHome)
    const store = createFakeStore({
      decision: 'accepted',
      owner: 'self',
      status: 'healthy',
      desktopId: DESKTOP_ENTRY_ID,
      installId: TEST_INSTALL_ID,
      previousSchemeHandler: null,
    })
    const fs = createFakeFs({ [desktopPath]: ownedEntry(APPIMAGE) })
    const xdg = createFakeXdg({ 'x-scheme-handler/motrix': DESKTOP_ENTRY_ID })
    const next = await removeSystemIntegration(baseDeps({ store, fs, xdg }))
    expect(fs.files.has(desktopPath)).toBe(true)
    expect(next.status).toBe('failed')
  })
})
