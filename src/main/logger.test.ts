import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRotatingLogStream } from './logger'

describe('createRotatingLogStream', () => {
  const dirs: string[] = []

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motrix-logger-test-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rotates existing oversized log files on startup', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'motrix.log')
    fs.writeFileSync(logFile, 'x'.repeat(200), 'utf8')

    const stream = createRotatingLogStream(logFile, { maxSize: 100 })
    stream.write('fresh-entry\n')
    stream.close()

    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('x'.repeat(200))
    expect(fs.readFileSync(logFile, 'utf8')).toBe('fresh-entry\n')
  })

  it('rotates logs during runtime and keeps total log disk usage bounded', () => {
    const dir = makeTempDir()
    const logFile = path.join(dir, 'motrix.log')
    const stream = createRotatingLogStream(logFile, { maxSize: 120 })

    // 连续写入远超单文件上限的日志，验证运行期会持续轮转且只保留一份 .1 备份
    for (let i = 0; i < 20; i++) {
      stream.write(`line-${String(i).padStart(2, '0')}-${'a'.repeat(30)}\n`)
    }
    stream.close()

    const currentSize = fs.statSync(logFile).size
    const backupSize = fs.statSync(`${logFile}.1`).size
    const files = fs.readdirSync(dir).sort()

    expect(files).toEqual(['motrix.log', 'motrix.log.1'])
    expect(currentSize).toBeLessThanOrEqual(120)
    expect(backupSize).toBeLessThanOrEqual(120)
    expect(fs.readFileSync(logFile, 'utf8')).toContain('line-19-')
  })
})
