import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assembleSegments } from './segment-assembler'

describe('SegmentAssembler', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mtx-test-'))
  })

  afterEach(async () => {
    // Clean up temp directory
    const { rm } = await import('node:fs/promises')
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('concatenates parts in given order without init', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')

    // Create test part files
    const part1 = Buffer.from('part1-data')
    const part2 = Buffer.from('part2-data')
    const part3 = Buffer.from('part3-data')

    const part1Path = join(tmpDir, 'part1.seg')
    const part2Path = join(tmpDir, 'part2.seg')
    const part3Path = join(tmpDir, 'part3.seg')

    writeFileSync(part1Path, part1)
    writeFileSync(part2Path, part2)
    writeFileSync(part3Path, part3)

    const outPath = join(tmpDir, 'output.ts')

    await assembleSegments({
      outPath,
      partPaths: [part1Path, part2Path, part3Path],
    })

    const output = readFileSync(outPath)
    const expected = Buffer.concat([part1, part2, part3])

    expect(output).toEqual(expected)
    expect(output.toString()).toBe('part1-datapart2-datapart3-data')
  })

  it('writes init bytes once at the front, then parts', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')

    const initData = Buffer.from('fmp4-init-segment')
    const part1 = Buffer.from('media-fragment-1')
    const part2 = Buffer.from('media-fragment-2')

    const initPath = join(tmpDir, 'init.mp4')
    const part1Path = join(tmpDir, 'part1.seg')
    const part2Path = join(tmpDir, 'part2.seg')

    writeFileSync(initPath, initData)
    writeFileSync(part1Path, part1)
    writeFileSync(part2Path, part2)

    const outPath = join(tmpDir, 'output.mp4')

    await assembleSegments({
      outPath,
      initPath,
      partPaths: [part1Path, part2Path],
    })

    const output = readFileSync(outPath)
    const expected = Buffer.concat([initData, part1, part2])

    expect(output).toEqual(expected)
    expect(output.toString()).toBe(
      'fmp4-init-segmentmedia-fragment-1media-fragment-2'
    )
  })

  it('preserves exact byte order with large buffers', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')

    // Create larger buffers to test streaming
    const init = Buffer.alloc(1024 * 100, 'A') // 100KB of 'A'
    const part1 = Buffer.alloc(1024 * 200, 'B') // 200KB of 'B'
    const part2 = Buffer.alloc(1024 * 150, 'C') // 150KB of 'C'

    const initPath = join(tmpDir, 'init')
    const part1Path = join(tmpDir, 'part1')
    const part2Path = join(tmpDir, 'part2')

    writeFileSync(initPath, init)
    writeFileSync(part1Path, part1)
    writeFileSync(part2Path, part2)

    const outPath = join(tmpDir, 'output')

    await assembleSegments({
      outPath,
      initPath,
      partPaths: [part1Path, part2Path],
    })

    const output = readFileSync(outPath)
    const expected = Buffer.concat([init, part1, part2])

    expect(output.length).toBe(expected.length)
    expect(output).toEqual(expected)

    // Spot-check content
    expect(output.slice(0, 100).every((b) => b === 65)).toBe(true) // 'A' = 65
    expect(
      output.slice(init.length, init.length + 100).every((b) => b === 66)
    ).toBe(true) // 'B' = 66
  })

  it('handles empty parts array with init', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')

    const initData = Buffer.from('just-init')

    const initPath = join(tmpDir, 'init.mp4')
    writeFileSync(initPath, initData)

    const outPath = join(tmpDir, 'output.mp4')

    await assembleSegments({
      outPath,
      initPath,
      partPaths: [],
    })

    const output = readFileSync(outPath)
    expect(output).toEqual(initData)
  })

  it('handles empty parts array without init', async () => {
    const { readFileSync, existsSync } = await import('node:fs')

    const outPath = join(tmpDir, 'output.ts')

    await assembleSegments({
      outPath,
      partPaths: [],
    })

    // File should be created (empty)
    expect(existsSync(outPath)).toBe(true)
    const output = readFileSync(outPath)
    expect(output.length).toBe(0)
  })

  it('respects part order (not sorted)', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs')

    // Create parts with distinct patterns
    const part0 = Buffer.from([0x00, 0x00])
    const part1 = Buffer.from([0x11, 0x11])
    const part2 = Buffer.from([0x22, 0x22])

    // Write in reverse lexical order
    const path0 = join(tmpDir, 'part-002.seg')
    const path1 = join(tmpDir, 'part-001.seg')
    const path2 = join(tmpDir, 'part-000.seg')

    writeFileSync(path0, part0)
    writeFileSync(path1, part1)
    writeFileSync(path2, part2)

    const outPath = join(tmpDir, 'output')

    // Assemble in specified order (not lexical)
    await assembleSegments({
      outPath,
      partPaths: [path2, path1, path0],
    })

    const output = readFileSync(outPath)
    const expected = Buffer.concat([part2, part1, part0])

    expect(output).toEqual(expected)
    expect(output).toEqual(Buffer.from([0x22, 0x22, 0x11, 0x11, 0x00, 0x00]))
  })
})
