import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadUrlMoext } from './url-fetcher'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'plugin-url-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('downloadUrlMoext', () => {
  it('uses the supplied transport and writes the bounded package', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('plugin'))
    const dest = path.join(directory, 'nested', 'plugin.moext')
    await downloadUrlMoext('https://plugins.example/package', dest, fetcher)
    expect(fetcher).toHaveBeenCalledWith('https://plugins.example/package', {
      redirect: 'follow',
    })
    expect(await readFile(dest, 'utf8')).toBe('plugin')
  })
  it('cancels an unsuccessful response', async () => {
    const cancel = vi.fn()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status: 503 })
      )
    await expect(
      downloadUrlMoext(
        'https://plugins.example/package',
        path.join(directory, 'plugin'),
        fetcher
      )
    ).rejects.toThrow('url_download_failed: 503')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('rejects an oversized stream without leaving a partial package', async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1))
          },
          cancel,
        })
      )
    )
    const dest = path.join(directory, 'plugin')
    await expect(
      downloadUrlMoext('https://plugins.example/package', dest, fetcher)
    ).rejects.toThrow('package_too_large')
    expect(cancel).toHaveBeenCalledOnce()
    await expect(readFile(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves transport errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('proxy unavailable'))
    await expect(
      downloadUrlMoext(
        'https://plugins.example/package',
        path.join(directory, 'plugin'),
        fetcher
      )
    ).rejects.toThrow('proxy unavailable')
  })
})
