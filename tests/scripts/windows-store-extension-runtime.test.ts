// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extensionFailure,
  fingerprintExtensionBuild,
  productionBrowserOrder,
  productionChromiumTarget,
  restartProductionWorker,
  runStoreExtensionRuntime,
  validateProtocolDialogObservation,
} from '../../scripts/test-windows-store-extension-runtime.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('isolated production worker restart', () => {
  function fixture(change: Record<string, unknown> = {}) {
    const id = 'a'.repeat(32)
    let stopped = false
    let reopened = false
    const initial = {
      type: 'service_worker',
      url: `chrome-extension://${id}/worker.js`,
      targetId: 'old',
      ...change,
    }
    const cdp = {
      send: vi.fn(async (method: string) => {
        if (method === 'SystemInfo.getProcessInfo')
          return { processInfo: [{ type: 'browser', id: 123 }] }
        if (method === 'Target.closeTarget') {
          stopped = true
          return { success: true }
        }
        return {
          targetInfos: stopped
            ? reopened
              ? [{ ...initial, targetId: 'new' }]
              : []
            : [initial],
        }
      }),
    }
    const options = {
      cdp,
      extensionId: id,
      workerScript: 'worker.js',
      browserPid: 123,
      closePopup: vi.fn(async () => {}),
      openPopup: vi.fn(async () => {
        reopened = true
        return 'page'
      }),
      reconnect: vi.fn(async () => {}),
      workerGeneration: vi.fn(async () => (reopened ? 2000 : 1000)),
      pause: vi.fn(async () => {}),
      observe: vi.fn(),
    }
    return options
  }
  it('requires old-target disappearance, replacement and the same browser before accepting reconnect', async () => {
    const options = fixture()
    const result = await restartProductionWorker(options)
    expect(result.evidence).toEqual({
      oldTargetStoppedVerified: true,
      newWorkerGenerationVerified: true,
      browserProcessUnchangedVerified: true,
      retainedCredentialReconnectVerified: true,
    })
    expect(options.cdp.send).toHaveBeenCalledWith('Target.closeTarget', {
      targetId: 'old',
    })
    expect(options.reconnect).toHaveBeenCalledWith('page')
    expect(options.observe).toHaveBeenLastCalledWith({ phase: 'complete' })
    expect(options.observe).toHaveBeenCalledWith({
      matchingWorkers: 1,
      exactScriptMatches: 1,
      attachedWorkers: 0,
    })
    expect(JSON.stringify(result.evidence)).not.toContain('chrome-extension')
  })
  it.each([
    { type: 'page' },
    { url: `chrome-extension://${'b'.repeat(32)}/worker.js` },
    { url: `chrome-extension://${'a'.repeat(32)}/different.js` },
    { targetId: '' },
  ])('never closes an unrelated or malformed target: %j', async (change) => {
    const options = fixture(change)
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'extension-worker-identity'
    )
    expect(
      options.cdp.send.mock.calls.some(
        ([method]) => method === 'Target.closeTarget'
      )
    ).toBe(false)
  })
  it.each(['../worker.js', '/worker.js', 'https://other/worker.js'])(
    'rejects unsafe manifest script %s',
    async (workerScript) => {
      const options = { ...fixture(), workerScript }
      await expect(restartProductionWorker(options)).rejects.toThrow(
        'extension-worker-identity'
      )
      expect(options.cdp.send).not.toHaveBeenCalled()
    }
  )
  it('refuses an ambiguous pair of production workers', async () => {
    const options = fixture()
    const original = options.cdp.send.getMockImplementation()!
    options.cdp.send.mockImplementation(async (method) => {
      const result = await original(method)
      if (method === 'Target.getTargets' && result.targetInfos)
        result.targetInfos.push({
          ...result.targetInfos[0],
          targetId: 'duplicate',
        })
      return result
    })
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'extension-worker-identity'
    )
    expect(options.closePopup).not.toHaveBeenCalled()
  })
  it('does not accept closeTarget success while the old worker still exists', async () => {
    const options = fixture()
    const original = options.cdp.send.getMockImplementation()!
    options.cdp.send.mockImplementation(async (method) =>
      method === 'Target.closeTarget' ? { success: true } : original(method)
    )
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'extension-worker-not-stopped'
    )
    expect(options.openPopup).not.toHaveBeenCalled()
    expect(options.observe).toHaveBeenCalledWith({
      phase: 'worker-stop-observation',
    })
    expect(options.observe).toHaveBeenLastCalledWith({ oldTargetPresent: true })
    expect(JSON.stringify(options.observe.mock.calls)).not.toContain(
      'chrome-extension'
    )
  })
  it('does not convert authentication failure into worker recovery', async () => {
    const options = fixture()
    options.reconnect.mockRejectedValue(new Error('not-connected'))
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'not-connected'
    )
  })
  it('accepts a reused target ID only after disappearance and a newer worker global', async () => {
    const options = fixture()
    const original = options.cdp.send.getMockImplementation()!
    options.cdp.send.mockImplementation(async (method) => {
      const result = await original(method)
      if (result.targetInfos)
        result.targetInfos.forEach((entry) => {
          entry.targetId = 'old'
        })
      return result
    })
    expect(
      (await restartProductionWorker(options)).evidence
        .newWorkerGenerationVerified
    ).toBe(true)
    expect(options.observe).toHaveBeenCalledWith({
      targetIdReused: true,
      generationChanged: true,
    })
  })
  it.each([1000, 999, NaN, Infinity])(
    'rejects an unchanged, older or invalid generation %s despite a new target ID',
    async (generation) => {
      const options = fixture()
      options.workerGeneration
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(generation)
      await expect(restartProductionWorker(options)).rejects.toThrow(
        'extension-worker-not-replaced'
      )
    }
  )
  it('refuses invalid initial generation before closing any target', async () => {
    const options = fixture()
    options.workerGeneration.mockResolvedValue(NaN)
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'extension-worker-generation'
    )
    expect(options.closePopup).not.toHaveBeenCalled()
  })
  it('rejects a browser process change even after successful reconnection', async () => {
    const options = fixture()
    const original = options.cdp.send.getMockImplementation()!
    options.cdp.send.mockImplementation(async (method) =>
      method === 'SystemInfo.getProcessInfo' &&
      options.reconnect.mock.calls.length
        ? { processInfo: [{ type: 'browser', id: 456 }] }
        : original(method)
    )
    await expect(restartProductionWorker(options)).rejects.toThrow(
      'extension-worker-browser-changed'
    )
  })
})

describe('protocol dialog evidence redaction', () => {
  const observation = {
    confirmed: true,
    cancelled: false,
    processIdentityVerified: true,
    ownedWindows: 1,
    openButtons: 1,
    eligibleDialogs: 1,
    namedOpenButtons: 1,
    dialogRoleAncestors: 1,
    exactTitleAncestors: 1,
    testAppTitleAncestors: 1,
    maxAncestorDepth: 5,
    ownershipBoundaries: 0,
  }
  it('keeps bounded structure and discards any raw UI text or path', () => {
    expect(
      validateProtocolDialogObservation({
        ...observation,
        title: 'private title',
        profile: 'private path',
        code: 'XXXX-XXXX',
      })
    ).toEqual(observation)
    expect(
      validateProtocolDialogObservation({
        ...observation,
        confirmed: false,
        cancelled: true,
      }).cancelled
    ).toBe(true)
  })
  it.each([
    { cancelled: true },
    { confirmed: 'true' },
    { cancelled: 'false' },
    { processIdentityVerified: false },
    { openButtons: -1 },
    { openButtons: 101 },
    { openButtons: 1.5 },
    { eligibleDialogs: 0 },
    { eligibleDialogs: 2 },
    { exactTitleAncestors: 0 },
    { dialogRoleAncestors: 0 },
    { maxAncestorDepth: 13 },
    { maxAncestorDepth: 0 },
    { ownershipBoundaries: '0' },
  ])('rejects contradictory, missing or unbounded evidence: %j', (change) => {
    expect(() =>
      validateProtocolDialogObservation({ ...observation, ...change })
    ).toThrow('protocol-confirmation-failed')
  })
  it('retains a failed search without turning it into consent', () => {
    const failed = {
      ...observation,
      confirmed: false,
      eligibleDialogs: 0,
      exactTitleAncestors: 0,
    }
    expect(validateProtocolDialogObservation(failed)).toEqual(failed)
  })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'store-extension-test-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      action: { default_popup: 'popup.html' },
      background: { service_worker: 'worker.js' },
      permissions: ['storage', 'nativeMessaging'],
    })
  )
  await writeFile(path.join(root, 'worker.js'), 'worker-source')
  return root
}

describe('production extension build binding', () => {
  it('binds every build file, including maps and relative names', async () => {
    const root = await fixture()
    const original = await fingerprintExtensionBuild(root)
    expect(original.files).toBe(2)
    expect(original.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await fingerprintExtensionBuild(root)).toEqual(original)
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'assets', 'source.map'), 'map')
    const withMap = await fingerprintExtensionBuild(root)
    expect(withMap.sha256).not.toBe(original.sha256)
    expect(withMap.files).toBe(3)
    await writeFile(path.join(root, 'worker.js'), 'changed-source')
    expect((await fingerprintExtensionBuild(root)).sha256).not.toBe(
      withMap.sha256
    )
  })
  it('refuses symlinks instead of incorporating outside files', async () => {
    const root = await fixture()
    await symlink(path.join(root, 'worker.js'), path.join(root, 'alias.js'))
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-link'
    )
  })
  it('rejects a fixture manifest with no production popup and worker', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'manifest.json'), '{}')
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-manifest'
    )
  })
  it('bounds input inventory', async () => {
    const root = await fixture()
    await Promise.all(
      Array.from({ length: 255 }, (_, i) =>
        writeFile(path.join(root, `${i}.js`), '')
      )
    )
    await expect(fingerprintExtensionBuild(root)).rejects.toThrow(
      'extension-build-limit'
    )
  })
})

describe('production browser evidence boundary', () => {
  it('maps only fixed stages to failure codes without exposing arbitrary text', () => {
    expect(extensionFailure('code-entry')).toBe('extension-code-entry-failed')
    expect(extensionFailure('secret code XXXX-XXXX')).toBe(
      'extension-operation-failed'
    )
  })
  it('fails closed before browser startup for malformed source provenance', async () => {
    const root = await fixture()
    const report = await runStoreExtensionRuntime({
      browserName: 'chrome',
      extensionDirectory: root,
      sourceCommit: 'invalid-commit',
      profileDirectory: root,
      appPort: 16800,
      readPairingCode: () => {
        throw new Error('must not run')
      },
    })
    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('extension-preflight-failed')
    expect(report.firstPairVerified).toBe(false)
    // Invalid inputs must not remove an existing directory.
    expect((await fingerprintExtensionBuild(root)).files).toBe(2)
  })
})

describe('production Chromium browser selection', () => {
  it('retains both brands and runs the requested application-closing case last', () => {
    expect(productionBrowserOrder('chrome')).toEqual(['edge', 'chrome'])
    expect(productionBrowserOrder('edge')).toEqual(['chrome', 'edge'])
  })
  it('selects the matching branded channel and evidence scope', () => {
    expect(productionChromiumTarget('chrome')).toEqual({
      browserName: 'chrome',
      channel: 'chrome',
      scope: 'installed-appx-production-chrome-extension',
    })
    expect(productionChromiumTarget('edge')).toEqual({
      browserName: 'edge',
      channel: 'msedge',
      scope: 'installed-appx-production-edge-extension',
    })
  })
  it.each(['firefox', 'chromium', 'edge --no-sandbox', '', undefined])(
    'rejects unsupported browser %s before launch',
    (name) => {
      expect(() => productionChromiumTarget(name)).toThrow(
        'extension-browser-unsupported'
      )
      expect(() => productionBrowserOrder(name)).toThrow(
        'extension-browser-unsupported'
      )
    }
  )
})
