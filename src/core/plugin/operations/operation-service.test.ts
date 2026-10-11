// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type BoundedJsonSchemaShape,
  ManifestSchema,
} from '@motrix/plugin-manifest-schema'
import { isOperationTerminal } from '@shared/schemas/plugin-operations'
import type { PluginManifest } from '@shared/types/plugin'
import {
  textOperationBundle,
  textOperationManifest,
} from '@test-utils/plugin-operation-fixture'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { FfmpegCapabilityHost } from '../capabilities/ffmpeg'
import type { CapabilityBridge } from '../host/capability-bridge'
import type { PluginHost } from '../host/plugin-host'
import { makeStubCapabilityHost, spawnTestBridge } from '../host/test-helpers'
import type { PluginRegistry } from '../plugin-registry'
import type { OperationExecution } from './operation-files'
import { OperationService } from './operation-service'

const binary = path.resolve(
  'packages/finalize-fs/target/debug/motrix-finalize-fs'
)
let manifest = textOperationManifest()
let manifestRaw = manifest
const owner = { id: 'operator-session', eligible: () => true }
describe('plugin operations with native files and real QuickJS', () => {
  let directory: string
  let service: OperationService
  let bridge: CapabilityBridge | undefined
  let policy: AbortController
  let invoke: ReturnType<typeof vi.fn>
  let enabled: boolean
  let capabilities: ReturnType<typeof makeStubCapabilityHost>
  beforeAll(() => {
    execFileSync(
      'cargo',
      [
        'build',
        '--manifest-path',
        'packages/finalize-fs/Cargo.toml',
        '--locked',
      ],
      { stdio: 'pipe' }
    )
  }, 60_000)
  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'operations-test-'))
    )
    manifest = textOperationManifest()
    manifestRaw = manifest
    policy = new AbortController()
    enabled = true
    await writeFile(path.join(directory, 'input.txt'), 'apple\npear\napple')
    await writeFile(
      path.join(directory, 'motrix-plugin.json'),
      JSON.stringify(manifest)
    )
    await writeFile(path.join(directory, 'plugin.js'), textOperationBundle)
    capabilities = makeStubCapabilityHost()
    invoke = vi.fn(
      async (
        _id: string,
        command: string,
        args: unknown,
        options: { operation: OperationExecution }
      ) => {
        const guest = await spawnTestBridge(directory, {
          capabilityHost: capabilities,
        })
        bridge = guest.bridge
        expect(guest.errorCode).toBeUndefined()
        try {
          return await bridge.callOperation(command, args, options.operation)
        } finally {
          await bridge.dispose()
        }
      }
    )
    service = new OperationService({
      binary,
      storage: path.join(directory, 'jobs'),
      capabilities,
      getTask: () => undefined,
      registry: {
        list: () => [
          {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            enabled,
          },
        ],
        get: () => ({ manifest, manifestRaw }),
        policyGenerationFor: () => 0,
      } as unknown as PluginRegistry,
      host: {
        isSecurityRestricted: () => false,
        isPolicyMutationPending: () => false,
        capturePolicyCheck: () => () => {
          policy.signal.throwIfAborted()
        },
        acquirePolicyLease: () => ({
          signal: policy.signal,
          generation: 0,
          release: vi.fn(),
        }),
        activate: vi.fn(),
        invokeCommand: invoke,
      } as unknown as PluginHost,
    })
    await service.initialize()
  })
  afterEach(async () => {
    await service.shutdown()
    await bridge?.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  async function draft() {
    let draft = await service.prepare(owner, {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
    })
    draft = await service.pick(owner, {
      draftId: draft.id,
      field: 'input',
      values: draft.args,
      candidate: path.join(directory, 'input.txt'),
    })
    draft = await service.pick(owner, {
      draftId: draft.id,
      field: 'output',
      values: draft.args,
      candidate: path.join(directory, 'output.txt'),
    })
    return draft
  }
  const request = (draft: Awaited<ReturnType<typeof service.prepare>>) => ({
    draftId: draft.id,
    descriptorRevision: draft.descriptor.descriptorRevision,
    idempotencyKey: randomUUID(),
    args: draft.args,
  })
  async function finish(id: string) {
    await vi.waitFor(
      () =>
        expect(isOperationTerminal(service.get(owner, id).status)).toBe(true),
      { timeout: 15000 }
    )
    return service.get(owner, id)
  }
  it('resumes the same owned draft across repeated page loads without consuming quota', async () => {
    const selected = await draft()
    const payload = {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
      resume: true,
    }
    const resumed = await Promise.all(
      Array.from({ length: 12 }, () => service.prepare(owner, payload))
    )
    for (const current of resumed) {
      expect(current.id).toBe(selected.id)
      expect(current.files).toEqual(selected.files)
      expect(current.expiresAt).toBe(selected.expiresAt)
    }
    const other = await service.prepare(
      { ...owner, id: 'another-session' },
      payload
    )
    expect(other.id).not.toBe(selected.id)
    expect(other.files).toEqual({})
    const job = await service.start(owner, request(selected))
    expect((await finish(job.id)).status).toBe('succeeded')
    expect(await readFile(path.join(directory, 'output.txt'), 'utf8')).toBe(
      'apple\npear'
    )
  })
  it('reclaims duplicate drafts left by older renderers before enforcing the quota', async () => {
    const payload = {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
    }
    const older = await service.prepare(owner, payload)
    await service.prepare(owner, payload)
    await service.prepare(owner, payload)
    const latest = await service.prepare(owner, payload)
    await expect(service.prepare(owner, payload)).rejects.toThrow(
      'pluginOperations.resourceLimit'
    )
    const resumed = await service.prepare(owner, { ...payload, resume: true })
    expect(resumed.id).toBe(latest.id)
    await expect(
      service.update(owner, { draftId: older.id, values: {} })
    ).rejects.toThrow('pluginOperations.draftExpired')
    await expect(service.prepare(owner, payload)).resolves.toHaveProperty('id')
    await expect(
      service.prepare(owner, {
        ...payload,
        resume: true,
        repeatJobId: randomUUID(),
      })
    ).rejects.toThrow('pluginOperations.invalidRequest')
  })
  it('does not resume draft grants from an earlier plugin revision', async () => {
    const selected = await draft()
    manifest.version = '0.2.0'
    const resumed = await service.prepare(owner, {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
      resume: true,
    })
    expect(resumed.id).not.toBe(selected.id)
    expect(resumed.files).toEqual({})
    await expect(service.start(owner, request(selected))).rejects.toThrow(
      'pluginOperations.draftExpired'
    )
  })
  it('repeats an unsigned text operation with fresh grants, retained options and no output', async () => {
    const first = await draft()
    first.args.ignoreCase = true
    const job = await service.start(owner, request(first))
    expect((await finish(job.id)).status).toBe('succeeded')
    expect(service.get(owner, job.id).outputs[0].location).toBe(
      path.join(directory, 'output.txt')
    )
    const second = await service.prepare(owner, {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
      repeatJobId: job.id,
    })
    expect(second.args.ignoreCase).toBe(true)
    expect(second.files.input.ref).not.toBe(first.files.input.ref)
    expect(second.files.input.location).toBe(first.files.input.location)
    expect(second.files.output).toBeUndefined()
    expect(second.args.output).toBeUndefined()
    expect(second.suggestions).toEqual({})
    await expect(
      service.prepare(
        { ...owner, id: 'other-session' },
        {
          pluginId: manifest.id,
          operationId: `${manifest.id}.deduplicate`,
          repeatJobId: job.id,
        }
      )
    ).rejects.toThrow('invalidRequest')
    await writeFile(path.join(directory, 'input.txt'), 'changed')
    await expect(
      service.prepare(owner, {
        pluginId: manifest.id,
        operationId: `${manifest.id}.deduplicate`,
        repeatJobId: job.id,
      })
    ).rejects.toThrow('fileChanged')
  })
  it('retains only scalar options on repeat without restoring files or task bindings', async () => {
    manifest.contributes.operations!.items[0].ui!.repeat = 'preserve-options'
    const first = await draft()
    first.args.ignoreCase = true
    const job = await service.start(owner, request(first))
    expect((await finish(job.id)).status).toBe('succeeded')
    await rm(path.join(directory, 'input.txt'))
    const second = await service.prepare(owner, {
      pluginId: manifest.id,
      operationId: `${manifest.id}.deduplicate`,
      repeatJobId: job.id,
      taskIds: ['old-task-must-not-be-rebound'],
    })
    expect(second.id).not.toBe(first.id)
    expect(second.args).toEqual({ ignoreCase: true })
    expect(second.files).toEqual({})
    expect(second.suggestions).toEqual({})
    await expect(
      service.start(owner, {
        ...request(second),
        args: { ...first.args },
      })
    ).rejects.toThrow()
    await expect(
      service.prepare(
        { ...owner, id: 'other-session' },
        {
          pluginId: manifest.id,
          operationId: `${manifest.id}.deduplicate`,
          repeatJobId: job.id,
        }
      )
    ).rejects.toThrow('invalidRequest')
  })
  it('invalidates output authority when a format changes and keeps the chosen directory', async () => {
    const op = manifest.contributes.operations!.items[0]
    const schema = manifest.contributes.commands![0]
      .argsSchema as BoundedJsonSchemaShape
    schema.properties!.format = {
      type: 'string',
      enum: ['txt', 'md'],
      default: 'txt',
    }
    schema.required!.push('format')
    op.fields.push({ field: 'format', widget: 'segmented' })
    op.ui!.layout = {
      type: 'stack',
      children: [
        { type: 'field', field: 'input' },
        { type: 'field', field: 'ignoreCase' },
        { type: 'field', field: 'output', accessory: 'format' },
      ],
    }
    Object.assign(op.files!.output, { extensionFrom: 'format' })
    const first = await draft()
    const second = await service.update(owner, {
      draftId: first.id,
      values: { ...first.args, format: 'md' },
    })
    expect(second.files.output).toBeUndefined()
    expect(second.suggestions?.output).toBe(path.join(directory, 'output.md'))
    expect(second.files.input.ref).toBe(first.files.input.ref)
    await expect(
      service.start(owner, {
        ...request(second),
        args: { ...second.args, output: first.args.output },
      })
    ).rejects.toThrow('invalidGrant')
    const selected = await service.pick(owner, {
      draftId: first.id,
      field: 'output',
      values: second.args,
      candidate: path.join(directory, 'chosen.txt'),
    })
    expect(selected.args.format).toBe('txt')
    expect(selected.files.output.ref).not.toBe(first.files.output.ref)
  })
  it.skipIf(!process.env.MOTRIX_TEST_TEXT_PLUGIN)(
    'runs the packed third-party SDK example with real QuickJS and no FFmpeg permission',
    async () => {
      const source = process.env.MOTRIX_TEST_TEXT_PLUGIN as string
      manifest = ManifestSchema.parse(
        JSON.parse(
          await readFile(path.join(source, 'motrix-plugin.json'), 'utf8')
        )
      ) as PluginManifest
      await writeFile(
        path.join(directory, 'motrix-plugin.json'),
        JSON.stringify({ ...manifest, main: 'plugin.js' })
      )
      await writeFile(
        path.join(directory, 'plugin.js'),
        await readFile(path.join(source, 'dist/plugin.js'))
      )
      manifestRaw = manifest
      expect(manifest.permissions).not.toContain('ffmpeg')
      expect(manifest.id).not.toMatch(/^motrix\./)
      const selected = await draft()
      const job = await service.start(owner, request(selected))
      const done = await finish(job.id)
      expect(done.status).toBe('succeeded')
      expect(done.result).toEqual({ lines: 2 })
      expect(await readFile(path.join(directory, 'output.txt'), 'utf8')).toBe(
        'apple\npear'
      )
    }
  )
  it.skipIf(
    !process.env.MOTRIX_TEST_FFMPEG || !process.env.MOTRIX_TEST_MEDIA_PLUGIN
  )(
    'runs the actual optional media plugin with reversed real tracks',
    async () => {
      const fixture = process.env.MOTRIX_TEST_MEDIA_PLUGIN as string
      const binaryPath = process.env.MOTRIX_TEST_FFMPEG as string
      manifest = JSON.parse(
        await readFile(path.join(fixture, 'motrix-plugin.json'), 'utf8')
      ) as PluginManifest
      await writeFile(
        path.join(directory, 'motrix-plugin.json'),
        JSON.stringify({ ...manifest, main: 'plugin.js' })
      )
      await writeFile(
        path.join(directory, 'plugin.js'),
        await readFile(path.join(fixture, manifest.main))
      )
      manifestRaw = manifest
      const video = path.join(directory, 'video.mp4')
      const audio = path.join(directory, 'audio.m4a')
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=32x32:r=5',
        '-t',
        '1',
        '-an',
        '-c:v',
        'libx264',
        video,
      ])
      execFileSync(binaryPath, [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:a',
        'aac',
        audio,
      ])
      capabilities.ffmpeg = new FfmpegCapabilityHost({
        detect: { available: true, binaryPath },
      })
      let selected = await service.prepare(owner, {
        pluginId: manifest.id,
        operationId: 'motrix.media-merge.merge',
      })
      for (const [field, candidate] of [
        ['videoInput', audio],
        ['audioInput', video],
        ['output', path.join(directory, 'merged.mkv')],
      ]) {
        selected = await service.pick(owner, {
          draftId: selected.id,
          field,
          values: selected.args,
          candidate,
        })
      }
      const start = await service.start(owner, request(selected))
      expect(await finish(start.id)).toMatchObject({
        status: 'succeeded',
        cleanupWarning: false,
      })
      const info = await capabilities.ffmpeg.probe({
        path: path.join(directory, 'merged.mkv'),
        localOnly: true,
      })
      expect(info.streams.map((stream) => stream.type)).toEqual([
        'video',
        'audio',
      ])
      const repeated = await service.prepare(owner, {
        pluginId: manifest.id,
        operationId: 'motrix.media-merge.merge',
        repeatJobId: start.id,
        taskIds: ['previous-video-task', 'previous-audio-task'],
      })
      expect(repeated.args).toEqual({ format: 'mkv' })
      expect(repeated.files).toEqual({})
      expect(repeated.suggestions).toEqual({})
      expect(repeated.id).not.toBe(selected.id)
      expect(
        await readFile(path.join(directory, 'merged.mkv'))
      ).not.toHaveLength(0)
    }
  )

  it('accepts a third-party text definition and completes without FFmpeg', async () => {
    expect(ManifestSchema.safeParse(manifest).success).toBe(true)
    const selected = await draft()
    const start = await service.start(owner, request(selected))
    const result = await finish(start.id)
    expect(result).toMatchObject({
      status: 'succeeded',
      result: { lines: 2 },
      cleanupWarning: false,
    })
    expect(await readFile(path.join(directory, 'output.txt'), 'utf8')).toBe(
      'apple\npear'
    )
    expect(await readFile(path.join(directory, 'input.txt'), 'utf8')).toBe(
      'apple\npear\napple'
    )
    expect(await readdir(path.join(directory, 'jobs/files'))).toEqual([])
    expect(
      (await readdir(directory)).filter((f) =>
        f.startsWith('.motrix-operation-')
      )
    ).toEqual([])
    expect(JSON.stringify(invoke.mock.calls[0][2])).not.toContain(directory)
  })
  it('returns the same job for retries and rejects a changed replay', async () => {
    const selected = await draft()
    const value = request(selected)
    const first = await service.start(owner, value)
    expect((await service.start(owner, value)).id).toBe(first.id)
    await expect(
      service.start(owner, {
        ...value,
        args: { ...value.args, ignoreCase: true },
      })
    ).rejects.toThrow('invalidRequest')
    await finish(first.id)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps draft authorization valid across presentation-only locale changes', async () => {
    const selected = await draft()
    manifest = structuredClone(manifestRaw)
    manifest.name = 'Localized text tools'
    manifest.contributes.operations!.items[0].title = 'Localized operation'
    manifest.contributes.operations!.items[0].fields[0].label =
      'Localized input'
    const current = service.catalog()[0]
    expect(current.descriptorRevision).toBe(
      selected.descriptor.descriptorRevision
    )
    expect(current.definition.title).toBe('Localized operation')
    const started = await service.start(owner, request(selected))
    expect((await finish(started.id)).status).toBe('succeeded')
  })
  it('rejects foreign owners, fabricated paths, stale revisions and consumed grants', async () => {
    const selected = await draft()
    const value = request(selected)
    await expect(
      service.start({ ...owner, id: 'other' }, value)
    ).rejects.toThrow('draftExpired')
    await expect(
      service.start(owner, { ...value, descriptorRevision: '0'.repeat(64) })
    ).rejects.toThrow('descriptorChanged')
    await expect(
      service.start(owner, {
        ...value,
        args: { ...value.args, input: '/etc/passwd' },
      })
    ).rejects.toThrow()
    const first = await service.start(owner, value)
    await finish(first.id)
    await expect(
      service.start(owner, { ...value, idempotencyKey: randomUUID() })
    ).rejects.toThrow('draftExpired')
  })
  it.each(['replace', 'edit', 'link'] as const)(
    'rejects an input %s after selection',
    async (action) => {
      const selected = await draft()
      const input = path.join(directory, 'input.txt')
      if (action === 'edit') await writeFile(input, 'different')
      else {
        await rename(input, `${input}.old`)
        if (action === 'replace') await writeFile(input, 'replacement')
        else await symlink(`${input}.old`, input)
      }
      const started = await service.start(owner, request(selected))
      expect(await finish(started.id)).toMatchObject({
        status: 'failed',
        error: 'pluginOperations.fileChanged',
        cleanupWarning: false,
      })
      expect(invoke).not.toHaveBeenCalled()
    }
  )
  it('does not overwrite a file created after output selection', async () => {
    const selected = await draft()
    await writeFile(path.join(directory, 'output.txt'), 'keep me')
    const started = await service.start(owner, request(selected))
    expect((await finish(started.id)).status).toBe('failed')
    expect(await readFile(path.join(directory, 'output.txt'), 'utf8')).toBe(
      'keep me'
    )
  })
  it('refuses direct generic command invocation without a selected-file scope', async () => {
    const guest = await spawnTestBridge(directory, {
      capabilityHost: capabilities,
    })
    bridge = guest.bridge
    await expect(
      guest.callPlugin(`${manifest.id}.deduplicate`, {})
    ).rejects.toThrow('Operation requires host authorization')
  })
  it('rejects a handler result that fabricates an output reference', async () => {
    await writeFile(
      path.join(directory, 'plugin.js'),
      `import {commands} from 'motrix:plugin-api'; commands.registerOperation('${manifest.id}.deduplicate', async (args, ctx) => { await ctx.files.writeText(args.output, 'temporary'); return {output:'${randomUUID()}', lines:1}; });`
    )
    const selected = await draft()
    const start = await service.start(owner, request(selected))
    const result = await finish(start.id)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('pluginOperations.invalidOutput')
    await expect(
      readFile(path.join(directory, 'output.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(path.join(directory, 'jobs/files'))).toEqual([])
  })
  it('aborts in-flight work when the plugin policy is revoked', async () => {
    await writeFile(
      path.join(directory, 'plugin.js'),
      `import {commands} from 'motrix:plugin-api'; commands.registerOperation('${manifest.id}.deduplicate', () => new Promise(() => {}));`
    )
    const selected = await draft()
    const start = await service.start(owner, request(selected))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    policy.abort()
    expect((await finish(start.id)).status).toBe('cancelled')
    expect(await readdir(path.join(directory, 'jobs/files'))).toEqual([])
  })
  it('classifies an owner revoked before the polling interval as cancelled', async () => {
    let eligible = true
    const eligibility = vi
      .spyOn(owner, 'eligible')
      .mockImplementation(() => eligible)
    const reader = { id: owner.id, eligible: () => true }
    try {
      invoke.mockImplementation(async () => {
        eligible = false
        throw new Error('pluginOperations.unauthorized')
      })
      const selected = await draft()
      const start = await service.start(owner, request(selected))
      await vi.waitFor(() =>
        expect(service.get(reader, start.id)).toMatchObject({
          status: 'cancelled',
          cleanupWarning: false,
        })
      )
      expect(service.get(reader, start.id).error).toBeUndefined()
      expect(await readdir(path.join(directory, 'jobs/files'))).toEqual([])
    } finally {
      eligibility.mockRestore()
    }
  })
  it('revokes drafts on disable and refuses unsupported requirements', async () => {
    manifest.contributes.operations!.items[0].requires = ['operations.v99']
    expect(service.state(owner).descriptors[0].unavailable).toBe('unsupported')
    manifest.contributes.operations!.items[0].requires = [
      'operations.v1',
      'files.text.v1',
    ]
    const selected = await draft()
    policy.abort()
    await expect(service.start(owner, request(selected))).rejects.toThrow()
    enabled = false
    expect(service.state(owner).descriptors[0].unavailable).toBe('disabled')
  })
  it('cancels a non-responsive plugin independently of its response', async () => {
    await writeFile(
      path.join(directory, 'plugin.js'),
      `import { commands } from 'motrix:plugin-api'; commands.registerOperation('${manifest.id}.deduplicate', () => new Promise(() => {}));`
    )
    const selected = await draft()
    const start = await service.start(owner, request(selected))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    service.cancel(owner, start.id)
    const cancelled = await finish(start.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.error).toBeUndefined()
    expect(await readdir(path.join(directory, 'jobs/files'))).toEqual([])
  })
})
