import {
  appendFileSync,
  createReadStream,
  fstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { link, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCommandGraph } from './command-graph'

const NOW = 1_800_000_000_000
const WINDOW_MS = 24 * 60 * 60 * 1000

interface AuditRecord {
  ts: number
  type: string
  caller: string
  callee: string
  commandId: string
  ok: boolean
}

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: NOW,
    type: 'command.invoke',
    caller: 'plugin.source',
    callee: 'plugin.target',
    commandId: 'plugin.target.run',
    ok: true,
    ...overrides,
  }
}

function serialize(records: AuditRecord[]): string {
  return `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

describe('readCommandGraph', () => {
  let tmp: string
  let file: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cg-'))
    file = path.join(tmp, 'command-invokes.ndjson')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function writeRecords(
    target: string,
    records: AuditRecord[]
  ): Promise<void> {
    await writeFile(target, serialize(records))
  }

  const options = {
    windowMs: WINDOW_MS,
    now: NOW,
    maxScanBytes: 64 * 1024 * 1024,
  }

  it('returns an empty complete graph when the directory or active file is missing', async () => {
    for (const target of [
      path.join(tmp, 'missing', 'command-invokes.ndjson'),
      file,
    ]) {
      await expect(readCommandGraph(target, options)).resolves.toEqual({
        edges: [],
        generatedAt: NOW,
        cutoff: NOW - WINDOW_MS,
        truncated: false,
      })
    }
  })

  it('aggregates by source, target, and command and keeps the newest timestamp', async () => {
    await writeRecords(file, [
      record({ ts: NOW - 3, commandId: 'plugin.target.run' }),
      record({ ts: NOW - 1, commandId: 'plugin.target.run' }),
      record({ ts: NOW - 2, commandId: 'plugin.target.other' }),
    ])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'plugin.source',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.other',
        calls: 1,
        lastCalledAt: NOW - 2,
      },
      {
        sourcePluginId: 'plugin.source',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.run',
        calls: 2,
        lastCalledAt: NOW - 1,
      },
    ])
  })

  it('sorts edges deterministically by source, target, and command', async () => {
    await writeRecords(file, [
      record({ caller: 'z', callee: 'a', commandId: 'b' }),
      record({ caller: 'a', callee: 'z', commandId: 'c' }),
      record({ caller: 'a', callee: 'b', commandId: 'z' }),
      record({ caller: 'a', callee: 'b', commandId: 'a' }),
    ])

    const graph = await readCommandGraph(file, options)

    expect(
      graph.edges.map((edge) => [
        edge.sourcePluginId,
        edge.targetPluginId,
        edge.commandId,
      ])
    ).toEqual([
      ['a', 'b', 'a'],
      ['a', 'b', 'z'],
      ['a', 'z', 'c'],
      ['z', 'a', 'b'],
    ])
  })

  it('excludes failed, stale, malformed, non-finite, and incomplete records', async () => {
    const raw = [
      JSON.stringify(record()),
      JSON.stringify(record({ ok: false })),
      JSON.stringify(record({ ts: NOW - WINDOW_MS - 1 })),
      'not json',
      '{"type":"command.invoke","ts":1e309,"caller":"a","callee":"b","commandId":"c","ok":true}',
      JSON.stringify({
        type: 'command.invoke',
        ts: NOW,
        caller: 'incomplete',
        callee: 'plugin.target',
        ok: true,
      }),
      JSON.stringify({ ...record(), type: 'other' }),
    ].join('\n')
    await writeFile(file, `${raw}\n`)

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'plugin.source',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.run',
        calls: 1,
        lastCalledAt: NOW,
      },
    ])
  })

  it('normalizes valid ids and rejects future, self, blank, and oversized ids', async () => {
    const oversized = 'x'.repeat(513)
    await writeRecords(file, [
      record({
        caller: '  plugin.source  ',
        callee: ' plugin.target ',
        commandId: ' plugin.target.run ',
      }),
      record({ ts: NOW + 1 }),
      record({ caller: 'same', callee: 'same' }),
      record({ caller: '   ' }),
      record({ callee: '\t' }),
      record({ commandId: '\n' }),
      record({ caller: oversized }),
      record({ callee: oversized }),
      record({ commandId: oversized }),
    ])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'plugin.source',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.run',
        calls: 1,
        lastCalledAt: NOW,
      },
    ])
  })

  it('aggregates active and eligible rotations exactly once', async () => {
    await writeRecords(file, [record({ ts: NOW - 1 })])
    await writeRecords(`${file}.${NOW - 10}`, [record({ ts: NOW - 10 })])
    await writeRecords(`${file}.${NOW - 20}`, [record({ ts: NOW - 20 })])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'plugin.source',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.run',
        calls: 3,
        lastCalledAt: NOW - 1,
      },
    ])
  })

  it('reads a hard-linked active file and rotation only once', async () => {
    await writeRecords(file, [record({ caller: 'hard-linked' })])
    await link(file, `${file}.${NOW - 10}`)

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'hard-linked',
        targetPluginId: 'plugin.target',
        commandId: 'plugin.target.run',
        calls: 1,
        lastCalledAt: NOW,
      },
    ])
    expect(graph.truncated).toBe(false)
  })

  it('reads eligible rotations when the active file is missing', async () => {
    await writeRecords(`${file}.${NOW - 10}`, [record({ ts: NOW - 10 })])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toHaveLength(1)
    expect(graph.truncated).toBe(false)
  })

  it('skips rotations older than the cutoff and unrelated siblings', async () => {
    await writeRecords(`${file}.${NOW - WINDOW_MS - 1}`, [record()])
    await writeRecords(`${file}.backup`, [record()])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([])
    expect(graph.truncated).toBe(false)
  })

  it('keeps delimiter-bearing aggregation keys collision-safe', async () => {
    await writeRecords(file, [
      record({ caller: 'a|b', callee: 'c', commandId: 'd' }),
      record({ caller: 'a', callee: 'b|c', commandId: 'd' }),
    ])

    const graph = await readCommandGraph(file, options)

    expect(graph.edges).toEqual([
      {
        sourcePluginId: 'a',
        targetPluginId: 'b|c',
        commandId: 'd',
        calls: 1,
        lastCalledAt: NOW,
      },
      {
        sourcePluginId: 'a|b',
        targetPluginId: 'c',
        commandId: 'd',
        calls: 1,
        lastCalledAt: NOW,
      },
    ])
  })

  it('hard-limits bytes and scans active then rotations newest first', async () => {
    const active = serialize([record({ caller: 'active' })])
    const newest = serialize([record({ caller: 'newest' })])
    const oldest = serialize([record({ caller: 'oldest' })])
    await writeFile(file, active)
    await writeFile(`${file}.${NOW - 10}`, newest)
    await writeFile(`${file}.${NOW - 20}`, oldest)

    const graph = await readCommandGraph(file, {
      ...options,
      maxScanBytes: Buffer.byteLength(active) + Buffer.byteLength(newest),
    })

    expect(graph.edges.map((edge) => edge.sourcePluginId)).toEqual([
      'active',
      'newest',
    ])
    expect(graph.truncated).toBe(true)
  })

  it('rediscovers once when the active file is renamed before open', async () => {
    await writeRecords(file, [record()])
    let listings = 0
    let opens = 0

    const graph = await readCommandGraph(file, options, {
      readdir: async (directory: string) => {
        listings += 1
        return readdir(directory)
      },
      stat,
      createReadStream: (
        target: string,
        streamOptions: { encoding: 'utf8'; start: number; end: number }
      ) => {
        if (opens++ === 0) renameSync(file, `${file}.${NOW}`)
        return createReadStream(target, streamOptions)
      },
    })

    expect(graph.edges).toHaveLength(1)
    expect(graph.truncated).toBe(false)
    expect(listings).toBe(2)
  })

  it('rediscovers when the active path is replaced between stat and open', async () => {
    await writeRecords(file, [record({ caller: 'before-rotation' })])
    const rotated = `${file}.${NOW}`
    let listings = 0
    let opens = 0

    const graph = await readCommandGraph(file, options, {
      readdir: async (directory: string) => {
        listings += 1
        return readdir(directory)
      },
      stat,
      createReadStream: (
        target: string,
        streamOptions: { encoding: 'utf8'; start: number; end: number }
      ) => {
        if (opens++ === 0) {
          renameSync(file, rotated)
          writeFileSync(file, serialize([record({ caller: 'after-rotation' })]))
        }
        return createReadStream(target, streamOptions)
      },
    })

    expect(graph.edges.map((edge) => edge.sourcePluginId)).toEqual([
      'after-rotation',
      'before-rotation',
    ])
    expect(graph.truncated).toBe(false)
    expect(listings).toBe(2)
  })

  it('skips a second-snapshot delete as truncated', async () => {
    await writeRecords(file, [record()])
    const rotated = `${file}.${NOW}`
    let opens = 0

    const graph = await readCommandGraph(file, options, {
      readdir,
      stat,
      createReadStream: (
        target: string,
        streamOptions: { encoding: 'utf8'; start: number; end: number }
      ) => {
        if (opens++ === 0) renameSync(file, rotated)
        else unlinkSync(rotated)
        return createReadStream(target, streamOptions)
      },
    })

    expect(graph.edges).toEqual([])
    expect(graph.truncated).toBe(true)
  })

  it('stops an active-file read at its snapshotted byte range', async () => {
    await writeRecords(file, [record({ caller: 'snapshotted' })])
    let appended = false

    const graph = await readCommandGraph(file, options, {
      readdir,
      stat,
      createReadStream: (
        target: string,
        streamOptions: { encoding: 'utf8'; start: number; end: number }
      ) => {
        if (!appended) {
          appended = true
          appendFileSync(file, serialize([record({ caller: 'appended' })]))
        }
        return createReadStream(target, streamOptions)
      },
    })

    expect(graph.edges.map((edge) => edge.sourcePluginId)).toEqual([
      'snapshotted',
    ])
    expect(graph.truncated).toBe(false)
  })

  it('rejects unexpected directory and read errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    await expect(
      readCommandGraph(file, options, {
        readdir: async () => {
          throw denied
        },
        stat,
        createReadStream,
      })
    ).rejects.toBe(denied)

    await writeRecords(file, [record()])
    await expect(
      readCommandGraph(file, options, {
        readdir,
        stat,
        createReadStream: () => {
          throw denied
        },
      })
    ).rejects.toBe(denied)
  })

  it('closes every opened file descriptor when fstat fails', async () => {
    await writeRecords(file, [record()])
    const failure = Object.assign(new Error('fstat failed'), { code: 'EIO' })
    const streams: ReturnType<typeof createReadStream>[] = []
    const fileDescriptors: number[] = []

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(
        readCommandGraph(file, options, {
          readdir,
          stat,
          fstat: async (fileDescriptor) => {
            fileDescriptors.push(fileDescriptor)
            throw failure
          },
          createReadStream: (target, streamOptions) => {
            const stream = createReadStream(target, streamOptions)
            streams.push(stream)
            return stream
          },
        })
      ).rejects.toBe(failure)
    }

    const allDestroyedBeforeCleanup = streams.every(
      (stream) => stream.destroyed
    )
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              resolve()
              return
            }
            stream.once('close', resolve)
            if (!stream.destroyed) stream.destroy()
          })
      )
    )

    expect(fileDescriptors).toHaveLength(50)
    expect(allDestroyedBeforeCleanup).toBe(true)
    expect(
      fileDescriptors.map((fileDescriptor) => {
        try {
          fstatSync(fileDescriptor)
          return 'open'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code
        }
      })
    ).toEqual(Array.from({ length: 50 }, () => 'EBADF'))
  })

  it('transfers a validated stream to readline without double-destroying it', async () => {
    await writeRecords(file, [record()])
    let destroyCalls = 0

    const graph = await readCommandGraph(file, options, {
      readdir,
      stat,
      createReadStream: (target, streamOptions) => {
        const stream = createReadStream(target, streamOptions)
        const destroy = stream.destroy.bind(stream)
        stream.destroy = (error) => {
          destroyCalls += 1
          return destroy(error)
        }
        return stream
      },
    })

    expect(graph.edges).toHaveLength(1)
    expect(destroyCalls).toBe(1)
  })

  it('uses valid, stale, and malformed retention markers conservatively', async () => {
    const marker = path.join(tmp, 'command-invokes.retention.json')

    await writeFile(
      marker,
      JSON.stringify({ version: 1, droppedThrough: NOW - WINDOW_MS })
    )
    expect((await readCommandGraph(file, options)).truncated).toBe(true)

    await writeFile(
      marker,
      JSON.stringify({ version: 1, droppedThrough: NOW - WINDOW_MS - 1 })
    )
    expect((await readCommandGraph(file, options)).truncated).toBe(false)

    await writeFile(marker, '{broken')
    expect((await readCommandGraph(file, options)).truncated).toBe(true)
  })

  it('does not open an oversized retention marker outside the scan budget', async () => {
    const marker = path.join(tmp, 'command-invokes.retention.json')
    await writeFile(marker, 'x'.repeat(8 * 1024))
    let markerOpened = false

    const graph = await readCommandGraph(
      file,
      { ...options, maxScanBytes: 1 },
      {
        readdir,
        stat,
        createReadStream: (target, streamOptions) => {
          if (target === marker) markerOpened = true
          return createReadStream(target, streamOptions)
        },
      }
    )

    expect(graph.truncated).toBe(true)
    expect(markerOpened).toBe(false)
  })

  it('observes a retention marker written before rotations are deleted', async () => {
    const rotated = `${file}.${NOW - 10}`
    const marker = path.join(tmp, 'command-invokes.retention.json')
    await writeRecords(rotated, [record({ ts: NOW - 10 })])
    let retained = false

    const graph = await readCommandGraph(file, options, {
      readdir: async (directory) => {
        if (!retained) {
          retained = true
          await writeFile(
            marker,
            JSON.stringify({ version: 1, droppedThrough: NOW - 10 })
          )
          unlinkSync(rotated)
        }
        return readdir(directory)
      },
      stat,
      createReadStream,
    })

    expect(graph.edges).toEqual([])
    expect(graph.truncated).toBe(true)
  })

  it('rejects unexpected retention marker I/O errors', async () => {
    const marker = path.join(tmp, 'command-invokes.retention.json')
    await writeFile(marker, JSON.stringify({ version: 1, droppedThrough: NOW }))
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })

    await expect(
      readCommandGraph(file, options, {
        readdir,
        stat,
        createReadStream: (target, streamOptions) => {
          if (target === marker) throw denied
          return createReadStream(target, streamOptions)
        },
      })
    ).rejects.toBe(denied)
  })
})
