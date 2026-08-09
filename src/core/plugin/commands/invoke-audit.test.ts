// src/core/plugin/commands/invoke-audit.test.ts
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandInvokeAudit, type CommandInvokeEntry } from './invoke-audit'

const SAMPLE: CommandInvokeEntry = {
  caller: 'plugin.a',
  callee: 'plugin.b',
  commandId: 'plugin.b.doThing',
  argsSize: 42,
  resultSize: 17,
  durMs: 3,
  depth: 1,
  ok: true,
}

const NOW = 1_800_000_000_000

function serializedSampleSize(): number {
  return Buffer.byteLength(
    `${JSON.stringify({ ts: NOW, type: 'command.invoke', ...SAMPLE })}\n`
  )
}

describe('CommandInvokeAudit', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'motrix-audit-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('writes a single NDJSON line with type+ts and all input fields', async () => {
    const file = path.join(tmp, 'sub', 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file)

    audit.log(SAMPLE)
    await audit.drain()

    const contents = await readFile(file, 'utf8')
    const lines = contents.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)

    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(parsed.type).toBe('command.invoke')
    expect(typeof parsed.ts).toBe('number')
    expect(parsed.caller).toBe(SAMPLE.caller)
    expect(parsed.callee).toBe(SAMPLE.callee)
    expect(parsed.commandId).toBe(SAMPLE.commandId)
    expect(parsed.argsSize).toBe(SAMPLE.argsSize)
    expect(parsed.resultSize).toBe(SAMPLE.resultSize)
    expect(parsed.durMs).toBe(SAMPLE.durMs)
    expect(parsed.depth).toBe(SAMPLE.depth)
    expect(parsed.ok).toBe(true)
  })

  it('coalesces multiple synchronous log() calls into one flush', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file)

    for (let i = 0; i < 5; i++) {
      audit.log({ ...SAMPLE, argsSize: i })
    }
    await audit.drain()

    const contents = await readFile(file, 'utf8')
    const lines = contents.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      const parsed = JSON.parse(lines[i] ?? '') as Record<string, unknown>
      expect(parsed.argsSize).toBe(i)
    }
  })

  it('records both successful and failed entries', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file)

    audit.log({ ...SAMPLE, ok: true })
    audit.log({
      ...SAMPLE,
      ok: false,
      errorCode: 'plugin.command.access_denied',
      resultSize: undefined,
    })
    await audit.drain()

    const contents = await readFile(file, 'utf8')
    const lines = contents.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    const a = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    const b = JSON.parse(lines[1] ?? '') as Record<string, unknown>
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
    expect(b.errorCode).toBe('plugin.command.access_denied')
  })

  it('rotates the file when size exceeds maxFileBytes', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file, 200)

    // Each entry serialises to well over 100 bytes thanks to the long
    // caller/callee strings below, so two batches comfortably cross 200B.
    const big: CommandInvokeEntry = {
      caller: 'plugin.with.a.deliberately.long.id.aaaaaaaaaaaa',
      callee: 'plugin.with.a.deliberately.long.id.bbbbbbbbbbbb',
      commandId:
        'plugin.with.a.deliberately.long.id.bbbbbbbbbbbb.theCommandName',
      argsSize: 1234,
      resultSize: 5678,
      durMs: 99,
      depth: 2,
      ok: true,
    }

    audit.log(big)
    audit.log(big)
    await audit.drain()
    audit.log(big)
    await audit.drain()

    const entries = await readdir(tmp)
    const rotated = entries.filter((e) =>
      /^command-invokes\.ndjson\.\d+$/.test(e)
    )
    expect(rotated.length).toBeGreaterThanOrEqual(1)
  })

  it('uses distinct monotonic numeric names for rotations in the same millisecond', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: Number.POSITIVE_INFINITY,
    })

    audit.log({ ...SAMPLE, argsSize: 1 })
    await audit.drain()
    audit.log({ ...SAMPLE, argsSize: 2 })
    await audit.drain()

    const rotations = (await readdir(tmp))
      .filter((name) => /^command-invokes\.ndjson\.\d+$/.test(name))
      .sort()
    expect(rotations).toEqual([
      `command-invokes.ndjson.${NOW}`,
      `command-invokes.ndjson.${NOW + 1}`,
    ])
    const argsSizes = await Promise.all(
      rotations.map(async (name) => {
        const line = (await readFile(path.join(tmp, name), 'utf8')).trim()
        return (JSON.parse(line) as { argsSize: number }).argsSize
      })
    )
    expect(argsSizes).toEqual([1, 2])
  })

  it('preserves an existing rotation and retention marker in a new logger', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const existingRotation = `${file}.${NOW}`
    const marker = path.join(tmp, 'command-invokes.retention.json')
    const existingRecord = `${JSON.stringify({
      ts: NOW - 1,
      type: 'command.invoke',
      ...SAMPLE,
      argsSize: 7,
    })}\n`
    const markerContents = JSON.stringify({
      version: 1,
      droppedThrough: NOW - 10,
    })
    await writeFile(existingRotation, existingRecord)
    await writeFile(marker, markerContents)
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: Number.POSITIVE_INFINITY,
    })

    audit.log({ ...SAMPLE, argsSize: 8 })
    await audit.drain()

    expect(await readFile(existingRotation, 'utf8')).toBe(existingRecord)
    expect(await readFile(`${file}.${NOW + 1}`, 'utf8')).toContain(
      '"argsSize":8'
    )
    expect(await readFile(marker, 'utf8')).toBe(markerContents)
  })

  it('swallows FS errors instead of throwing', async () => {
    const bad = '/__definitely_not_a_real_root_dir_xyz__/file.ndjson'
    const audit = new CommandInvokeAudit(bad)

    expect(() => audit.log(SAMPLE)).not.toThrow()
    await expect(audit.drain()).resolves.toBeUndefined()
  })

  it('handles logs that arrive across flush boundaries', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const audit = new CommandInvokeAudit(file)

    audit.log({ ...SAMPLE, argsSize: 1 })
    audit.log({ ...SAMPLE, argsSize: 2 })
    audit.log({ ...SAMPLE, argsSize: 3 })
    await audit.drain()

    audit.log({ ...SAMPLE, argsSize: 4 })
    audit.log({ ...SAMPLE, argsSize: 5 })
    await audit.drain()

    const contents = await readFile(file, 'utf8')
    const lines = contents.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(5)
    const sizes = lines.map(
      (l) => (JSON.parse(l) as { argsSize: number }).argsSize
    )
    expect(sizes).toEqual([1, 2, 3, 4, 5])
  })

  it('removes rotations older than the retention age after rotating', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const retentionMs = 48 * 60 * 60 * 1000
    const stale = `${file}.${NOW - retentionMs - 1}`
    const boundary = `${file}.${NOW - retentionMs}`
    const unrelated = `${file}.backup`
    await writeFile(stale, 'stale')
    await writeFile(boundary, 'boundary')
    await writeFile(unrelated, 'unrelated')
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs,
      maxRetentionBytes: Number.POSITIVE_INFINITY,
    })

    audit.log(SAMPLE)
    await audit.drain()

    const names = await readdir(tmp)
    expect(names).not.toContain(path.basename(stale))
    expect(names).toContain(path.basename(boundary))
    expect(names).toContain(path.basename(unrelated))
  })

  it('enforces the rotation byte cap oldest-first and records the greatest deletion', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const oldest = `${file}.${NOW - 30}`
    const middle = `${file}.${NOW - 20}`
    const newest = `${file}.${NOW - 10}`
    await writeFile(oldest, 'a'.repeat(10))
    await writeFile(middle, 'b'.repeat(10))
    await writeFile(newest, 'c'.repeat(10))
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: serializedSampleSize() + 10,
    })

    audit.log(SAMPLE)
    await audit.drain()

    const names = await readdir(tmp)
    expect(names).not.toContain(path.basename(oldest))
    expect(names).not.toContain(path.basename(middle))
    expect(names).toContain(path.basename(newest))
    expect(names).toContain(`command-invokes.ndjson.${NOW}`)
    const marker = JSON.parse(
      await readFile(path.join(tmp, 'command-invokes.retention.json'), 'utf8')
    ) as unknown
    expect(marker).toEqual({ version: 1, droppedThrough: NOW - 20 })
  })

  it('writes the marker before deleting eligible cap rotations', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const eligible = `${file}.${NOW - 10}`
    const marker = path.join(tmp, 'command-invokes.retention.json')
    await writeFile(eligible, 'a'.repeat(10))
    let eligibleExistedAtMarkerWrite = false
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: serializedSampleSize(),
      atomicWriteMarker: async (target, contents) => {
        eligibleExistedAtMarkerWrite = (await readdir(tmp)).includes(
          path.basename(eligible)
        )
        await writeFile(target, contents)
      },
    })

    audit.log(SAMPLE)
    await audit.drain()

    expect(eligibleExistedAtMarkerWrite).toBe(true)
    expect(await readFile(marker, 'utf8')).toBe(
      JSON.stringify({ version: 1, droppedThrough: NOW - 10 })
    )
    expect(await readdir(tmp)).not.toContain(path.basename(eligible))
  })

  it('keeps eligible cap deletions when marker temp write fails', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const eligible = `${file}.${NOW - 10}`
    await writeFile(eligible, 'a'.repeat(10))
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: serializedSampleSize(),
      atomicWriteMarker: async () => {
        throw new Error('write failed')
      },
    })

    expect(() => audit.log(SAMPLE)).not.toThrow()
    await expect(audit.drain()).resolves.toBeUndefined()

    const names = await readdir(tmp)
    expect(names).toContain(path.basename(eligible))
    expect(names).toContain(`command-invokes.ndjson.${NOW}`)
    expect(names).not.toContain('command-invokes.retention.json')
  })

  it('keeps eligible rotations and cleans the temp file when marker rename fails', async () => {
    const file = path.join(tmp, 'command-invokes.ndjson')
    const eligible = `${file}.${NOW - 10}`
    const marker = path.join(tmp, 'command-invokes.retention.json')
    await writeFile(eligible, 'a'.repeat(10))
    const renameFailure = new Error('rename failed')
    let callbackInvoked = false
    let observedTemporary: string | undefined
    let observedTarget: string | undefined
    let observedContents: string | undefined
    let observedMarker: unknown
    let tempReadError: unknown
    const audit = new CommandInvokeAudit(file, 1, {
      now: () => NOW,
      retentionMs: NOW,
      maxRetentionBytes: serializedSampleSize(),
      renameMarker: async (source: string, target: string) => {
        callbackInvoked = true
        observedTemporary = source
        observedTarget = target
        try {
          observedContents = await readFile(source, 'utf8')
          observedMarker = JSON.parse(observedContents) as unknown
        } catch (error) {
          tempReadError = error
        }
        throw renameFailure
      },
    })

    expect(() => audit.log(SAMPLE)).not.toThrow()
    await expect(audit.drain()).resolves.toBeUndefined()

    expect(callbackInvoked).toBe(true)
    expect(observedTarget).toBe(marker)
    expect(observedTemporary).toBeDefined()
    expect(observedTemporary?.startsWith(`${marker}.`)).toBe(true)
    expect(observedContents).toBe(
      JSON.stringify({ version: 1, droppedThrough: NOW - 10 })
    )
    expect(tempReadError).toBeUndefined()
    expect(observedMarker).toEqual({
      version: 1,
      droppedThrough: NOW - 10,
    })
    if (observedTemporary === undefined) {
      throw new Error('rename callback did not expose the marker temp path')
    }
    await expect(readFile(observedTemporary, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const names = await readdir(tmp)
    expect(names).toContain(path.basename(eligible))
    expect(names).toContain(`command-invokes.ndjson.${NOW}`)
    expect(names).not.toContain('command-invokes.retention.json')
  })
})
