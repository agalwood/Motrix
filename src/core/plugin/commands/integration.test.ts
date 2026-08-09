// src/core/plugin/commands/integration.test.ts
//
// End-to-end coverage of FullCrossPluginInvoker. We wire real safeguards
// (SchemaCache, RateLimiter, CallerThrottle, ChainDepth, CommandInvokeAudit)
// against stubbed PluginRegistry + InvokerHost surfaces so each failure
// path can be triggered without standing up a real plugin VM.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  ManifestContributes,
  PluginManifest,
  PluginStateRecord,
} from '@shared/types/plugin'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexedPlugin, PluginRegistry } from '../plugin-registry'
import { CallerThrottle } from './caller-throttle'
import { ChainDepth } from './chain-depth'
import {
  FullCrossPluginInvoker,
  type InvokerHost,
} from './cross-plugin-invoker'
import { CommandInvokeAudit } from './invoke-audit'
import { RateLimiter } from './rate-limiter'
import { SchemaCache } from './schema-cache'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface PluginSpec {
  id: string
  enabled?: boolean
  invokesCommands?: string[]
  publicCommands?: Array<{
    id: string
    argsSchema?: unknown
    resultSchema?: unknown
    public?: boolean
  }>
}

function makeRegistry(plugins: PluginSpec[]): PluginRegistry {
  const byId = new Map<string, IndexedPlugin>()
  for (const spec of plugins) {
    const contributes: ManifestContributes = {
      commands: (spec.publicCommands ?? []).map((c) => ({
        id: c.id,
        title: c.id,
        public: c.public ?? true,
      })),
    }
    const manifest: PluginManifest = {
      manifestVersion: 1,
      id: spec.id,
      name: spec.id,
      version: '1.0.0',
      description: '',
      categories: [],
      engines: { motrix: '*' },
      main: 'index.js',
      permissions: [],
      invokesCommands: spec.invokesCommands ?? [],
      activationEvents: [],
      contributes,
    }
    const state: PluginStateRecord = {
      pluginId: spec.id,
      enabled: spec.enabled ?? true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    }
    byId.set(spec.id, {
      manifestRaw: manifest,
      manifest,
      origin: 'community',
      rootDir: `/fake/${spec.id}`,
      state,
    })
  }
  return {
    get: (id: string) => byId.get(id),
  } as unknown as PluginRegistry
}

interface HostStubOpts {
  active?: Set<string>
  invokeCommand?: (
    pluginId: string,
    commandId: string,
    args: unknown
  ) => Promise<unknown>
  activate?: (pluginId: string) => Promise<void>
}

function makeHost(opts: HostStubOpts = {}): InvokerHost {
  const active = opts.active ?? new Set<string>()
  return {
    isActive: (id) => active.has(id),
    activate: opts.activate ?? (async () => undefined),
    invokeCommand:
      opts.invokeCommand ??
      (async () => {
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          'host.invokeCommand not stubbed'
        )
      }),
  }
}

// Standard schemas used across most cases.
const ARGS_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
} as const
const RESULT_SCHEMA = {
  type: 'object',
  properties: { greeting: { type: 'string' } },
  required: ['greeting'],
  additionalProperties: false,
} as const

interface Harness {
  registry: PluginRegistry
  host: InvokerHost
  schemas: SchemaCache
  rateLimiter: RateLimiter
  throttle: CallerThrottle
  depth: ChainDepth
  audit: CommandInvokeAudit
  auditFile: string
  invoker: FullCrossPluginInvoker
}

function buildHarness(opts: {
  registry: PluginRegistry
  host: InvokerHost
  auditFile: string
  rateLimiter?: RateLimiter
  throttle?: CallerThrottle
  depth?: ChainDepth
  taskId?: () => string | undefined
  argsMaxBytes?: number
  resultMaxBytes?: number
  activationTimeoutMs?: number
  publicCmds?: Map<
    string,
    ReadonlyArray<{
      id: string
      argsSchema?: unknown
      resultSchema?: unknown
      public?: boolean
    }>
  >
}): Harness {
  const schemas = new SchemaCache()
  if (opts.publicCmds) {
    for (const [pluginId, cmds] of opts.publicCmds) {
      schemas.installCommandSchemas(pluginId, cmds)
    }
  }
  const rateLimiter =
    opts.rateLimiter ?? new RateLimiter({ limit: 100, windowMs: 60_000 })
  const throttle =
    opts.throttle ??
    new CallerThrottle({
      threshold: 100,
      windowMs: 60_000,
      blockMs: 60_000,
    })
  const depth = opts.depth ?? new ChainDepth(8)
  const audit = new CommandInvokeAudit(opts.auditFile)
  const invoker = new FullCrossPluginInvoker({
    registry: opts.registry,
    host: opts.host,
    schemas,
    rateLimiter,
    throttle,
    depth,
    audit,
    taskIdProvider: opts.taskId ?? (() => undefined),
    argsMaxBytes: opts.argsMaxBytes,
    resultMaxBytes: opts.resultMaxBytes,
    activationTimeoutMs: opts.activationTimeoutMs ?? 5_000,
  })
  return {
    registry: opts.registry,
    host: opts.host,
    schemas,
    rateLimiter,
    throttle,
    depth,
    audit,
    auditFile: opts.auditFile,
    invoker,
  }
}

async function readAuditEntries(
  file: string
): Promise<Array<Record<string, unknown>>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FullCrossPluginInvoker', () => {
  let tmp: string
  let auditFile: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'motrix-xplugin-'))
    auditFile = path.join(tmp, 'command-invokes.ndjson')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns the callee result on the happy path', async () => {
    const registry = makeRegistry([
      {
        id: 'test.caller',
        invokesCommands: ['test.callee.run'],
        publicCommands: [],
      },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async (_id, _cmd, args) => ({
        greeting: `hi ${(args as { name: string }).name}`,
      }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({ registry, host, auditFile, publicCmds: cmds })

    const out = await h.invoker.execute('test.caller', 'test.callee.run', {
      name: 'world',
    })
    expect(out).toEqual({ greeting: 'hi world' })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.ok).toBe(true)
    expect(entries[0]?.errorCode).toBeUndefined()
    expect(entries[0]?.caller).toBe('test.caller')
    expect(entries[0]?.callee).toBe('test.callee')
    expect(entries[0]?.commandId).toBe('test.callee.run')
  })

  it('rejects with access_denied when caller has not declared the command', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: [] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({ active: new Set(['test.callee']) })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({ registry, host, auditFile, publicCmds: cmds })

    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'x' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.access_denied',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.ok).toBe(false)
    expect(entries[0]?.errorCode).toBe('plugin.command.access_denied')
  })

  it('rejects with not_public when the callee command is not exposed', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: false,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({ active: new Set(['test.callee']) })
    // Note: SchemaCache installs only public commands, so leave it empty.
    const h = buildHarness({ registry, host, auditFile })

    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'x' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.not_public',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.not_public')
  })

  it('rejects with rate_limited once the per-pair budget is exhausted', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async () => ({ greeting: 'hello' }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      rateLimiter: new RateLimiter({ limit: 2, windowMs: 60_000 }),
      publicCmds: cmds,
    })

    await h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    await h.invoker.execute('test.caller', 'test.callee.run', { name: 'b' })
    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'c' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.rate_limited',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(3)
    expect(entries[0]?.ok).toBe(true)
    expect(entries[1]?.ok).toBe(true)
    expect(entries[2]?.ok).toBe(false)
    expect(entries[2]?.errorCode).toBe('plugin.command.rate_limited')
  })

  it('blocks the caller once schema-invalid attempts cross the throttle threshold', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async () => ({ greeting: 'hello' }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      throttle: new CallerThrottle({
        threshold: 3,
        windowMs: 60_000,
        blockMs: 5 * 60_000,
      }),
      publicCmds: cmds,
    })

    // 3 invalid attempts arm the block (throttle counts on the 3rd record).
    for (let i = 0; i < 3; i++) {
      await expect(
        // missing required `name` → real schema mismatch
        h.invoker.execute('test.caller', 'test.callee.run', {})
      ).rejects.toMatchObject({
        message: 'plugin.command.args_invalid',
      })
    }

    // 4th attempt — caller is now blocked, regardless of args validity.
    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.caller_throttled',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(4)
    expect(entries[0]?.errorCode).toBe('plugin.command.args_invalid')
    expect(entries[1]?.errorCode).toBe('plugin.command.args_invalid')
    expect(entries[2]?.errorCode).toBe('plugin.command.args_invalid')
    expect(entries[3]?.errorCode).toBe('plugin.command.caller_throttled')
  })

  it('rejects with result_invalid when the handler returns a shape that fails the schema', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async () => ({ wrong: 'shape' }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({ registry, host, auditFile, publicCmds: cmds })

    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.result_invalid',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.result_invalid')
  })

  it('rejects with chain_too_deep when the per-task depth would exceed max', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({ active: new Set(['test.callee']) })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const depth = new ChainDepth(2)
    const h = buildHarness({
      registry,
      host,
      auditFile,
      depth,
      taskId: () => 'task-1',
      publicCmds: cmds,
    })
    // Pre-enter twice so the next entry inside invoker.execute lands at 3.
    depth.enter('task-1')
    depth.enter('task-1')

    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.chain_too_deep',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.errorCode).toBe('plugin.command.chain_too_deep')
    expect(entries[0]?.depth).toBe(3)
    // Depth was decremented by the finally block — confirm it's back to 2.
    expect(depth.current('task-1')).toBe(2)
  })

  it('redacts the callee error message when the handler throws', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async () => {
        throw new Error('callee secret message')
      },
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({ registry, host, auditFile, publicCmds: cmds })

    let caught: unknown
    try {
      await h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    const err = caught as AppError
    expect(err.code).toBe(ErrorCode.PluginRuntimeFault)
    expect(err.message).toBe('plugin.command.handler_threw')
    expect(err.message).not.toContain('callee secret message')
    expect(err.cause).toEqual({ calleeMessage: 'redacted' })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.handler_threw')
  })

  it('rejects with activation_timeout when the host activate stalls past the deadline', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    // activate eventually resolves (200ms) so the slow promise still
    // settles cleanly — but the 50ms timeout fires first.
    const host = makeHost({
      active: new Set(),
      activate: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      activationTimeoutMs: 50,
      publicCmds: cmds,
    })

    const started = Date.now()
    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.activation_timeout',
    })
    expect(Date.now() - started).toBeLessThan(300)

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.activation_timeout')
  })

  it('rejects with args_too_large when the args payload exceeds argsMaxBytes', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({ active: new Set(['test.callee']) })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      argsMaxBytes: 100,
      publicCmds: cmds,
    })

    const big = { name: 'x'.repeat(500) }
    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', big)
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.args_too_large',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.args_too_large')
  })

  it('rejects with result_too_large when the result payload exceeds resultMaxBytes', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async () => ({ greeting: 'y'.repeat(2000) }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      resultMaxBytes: 100,
      publicCmds: cmds,
    })

    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    ).rejects.toMatchObject({
      code: ErrorCode.PluginRuntimeFault,
      message: 'plugin.command.result_too_large',
    })

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries.at(-1)?.errorCode).toBe('plugin.command.result_too_large')
  })

  it('writes exactly one audit entry per execute regardless of outcome', async () => {
    const registry = makeRegistry([
      { id: 'test.caller', invokesCommands: ['test.callee.run'] },
      {
        id: 'test.callee',
        publicCommands: [
          {
            id: 'test.callee.run',
            public: true,
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
          },
        ],
      },
    ])
    const host = makeHost({
      active: new Set(['test.callee']),
      invokeCommand: async (_id, _cmd, args) => ({
        greeting: `hi ${(args as { name: string }).name}`,
      }),
    })
    const cmds = new Map([
      [
        'test.callee',
        [
          {
            id: 'test.callee.run',
            argsSchema: ARGS_SCHEMA,
            resultSchema: RESULT_SCHEMA,
            public: true,
          },
        ],
      ],
    ])
    const h = buildHarness({
      registry,
      host,
      auditFile,
      rateLimiter: new RateLimiter({ limit: 1, windowMs: 60_000 }),
      publicCmds: cmds,
    })

    // 1) success
    await h.invoker.execute('test.caller', 'test.callee.run', { name: 'a' })
    // 2) rate-limited
    await expect(
      h.invoker.execute('test.caller', 'test.callee.run', { name: 'b' })
    ).rejects.toThrow()
    // 3) malformed commandId — fewer than 3 parts
    await expect(
      h.invoker.execute('test.caller', 'foo.bar', { name: 'c' })
    ).rejects.toThrow()

    await h.audit.drain()
    const entries = await readAuditEntries(auditFile)
    expect(entries).toHaveLength(3)
    expect(entries[0]?.ok).toBe(true)
    expect(entries[1]?.ok).toBe(false)
    expect(entries[1]?.errorCode).toBe('plugin.command.rate_limited')
    expect(entries[2]?.ok).toBe(false)
    expect(entries[2]?.errorCode).toBe('plugin.command.access_denied')
    // NDJSON ordering invariant
    for (const e of entries) {
      expect(typeof e.ts).toBe('number')
      expect(e.type).toBe('command.invoke')
    }
  })
})
