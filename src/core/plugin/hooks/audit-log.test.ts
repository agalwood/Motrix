import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HookAuditLog } from './audit-log'

describe('HookAuditLog', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'audit-log-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends one NDJSON line per log call', async () => {
    const file = path.join(dir, 'sub/chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.commit', taskId: 't1' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('chain.commit')
    expect(parsed.taskId).toBe('t1')
    expect(typeof parsed.ts).toBe('number')
  })

  it('logs chain.abort events', async () => {
    const file = path.join(dir, 'chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.abort', reason: 'timeout' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('chain.abort')
    expect(parsed.reason).toBe('timeout')
    expect(typeof parsed.ts).toBe('number')
  })

  it('batches multiple log calls in same tick into one appendFile', async () => {
    const file = path.join(dir, 'chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.commit', taskId: 't1' })
    await log.log({ type: 'chain.abort', reason: 'error' })
    await log.log({ type: 'chain.commit', taskId: 't2' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).taskId).toBe('t1')
    expect(JSON.parse(lines[1]).reason).toBe('error')
    expect(JSON.parse(lines[2]).taskId).toBe('t2')
  })

  it('creates parent directory if missing', async () => {
    const file = path.join(dir, 'deeply/nested/dir/chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.commit', taskId: 't1' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).taskId).toBe('t1')
  })

  it('each line is valid JSON with ts field', async () => {
    const file = path.join(dir, 'chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.commit', taskId: 't1' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    lines.forEach((line) => {
      const parsed = JSON.parse(line)
      expect(typeof parsed.ts).toBe('number')
      expect(parsed.ts > 0).toBe(true)
    })
  })

  it('multiple calls across ticks produce distinct lines', async () => {
    const file = path.join(dir, 'chain-commits.ndjson')
    const log = new HookAuditLog(file)
    await log.log({ type: 'chain.commit', taskId: 't1' })
    await log.drain()
    await log.log({ type: 'chain.commit', taskId: 't2' })
    await log.drain()
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).taskId).toBe('t1')
    expect(JSON.parse(lines[1]).taskId).toBe('t2')
    const ts1 = JSON.parse(lines[0]).ts
    const ts2 = JSON.parse(lines[1]).ts
    expect(ts2 >= ts1).toBe(true)
  })
})
