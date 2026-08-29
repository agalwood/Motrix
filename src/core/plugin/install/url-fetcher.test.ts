import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  compose: vi.fn(),
  destroy: vi.fn(async () => undefined),
  redirect: vi.fn(),
  dispatcher: { kind: 'composed-dispatcher' },
  interceptor: { kind: 'redirect-interceptor' },
}))

vi.mock('undici', () => ({
  Agent: class MockAgent {
    compose(interceptor: unknown) {
      mocks.compose(interceptor)
      return mocks.dispatcher
    }

    destroy() {
      return mocks.destroy()
    }
  },
  interceptors: {
    redirect(options: unknown) {
      mocks.redirect(options)
      return mocks.interceptor
    },
  },
  request: (...args: unknown[]) => mocks.request(...args),
}))

const { downloadUrlMoext } = await import('./url-fetcher')

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'motrix-url-fetcher-'))
  mocks.request.mockReset()
  mocks.compose.mockClear()
  mocks.destroy.mockClear()
  mocks.redirect.mockClear()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('downloadUrlMoext', () => {
  it('streams a successful response and destroys its owned Agent', async () => {
    mocks.request.mockResolvedValueOnce({
      statusCode: 200,
      body: Readable.from(Buffer.from('plugin-bytes')),
    })
    const destination = path.join(tempDir, 'nested', 'plugin.moext')

    await downloadUrlMoext('https://plugins.example/plugin.moext', destination)

    expect((await readFile(destination)).toString()).toBe('plugin-bytes')
    expect(mocks.redirect).toHaveBeenCalledWith({ maxRedirections: 5 })
    expect(mocks.compose).toHaveBeenCalledWith(mocks.interceptor)
    expect(mocks.request).toHaveBeenCalledWith(
      'https://plugins.example/plugin.moext',
      { dispatcher: mocks.dispatcher }
    )
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('cancels a non-200 response body before destroying the Agent', async () => {
    const body = Readable.from(Buffer.from('server error'))
    const once = vi.spyOn(body, 'once')
    const destroy = vi.spyOn(body, 'destroy')
    mocks.request.mockResolvedValueOnce({ statusCode: 503, body })
    const destination = path.join(tempDir, 'plugin.moext')

    await expect(
      downloadUrlMoext('https://plugins.example/plugin.moext', destination)
    ).rejects.toMatchObject({
      message: 'plugin.install.url_download_failed: 503',
    })

    expect(once).toHaveBeenCalledWith('error', expect.any(Function))
    expect(destroy).toHaveBeenCalled()
    expect(once.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0] as number
    )
    expect(mocks.destroy).toHaveBeenCalledOnce()
    await expect(readFile(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('removes a partial file and destroys the Agent on a body stream error', async () => {
    let emitted = false
    const body = new Readable({
      read() {
        if (emitted) return
        emitted = true
        this.push(Buffer.from('partial'))
        this.destroy(new Error('stream failed'))
      },
    })
    mocks.request.mockResolvedValueOnce({ statusCode: 200, body })
    const destination = path.join(tempDir, 'plugin.moext')

    await expect(
      downloadUrlMoext('https://plugins.example/plugin.moext', destination)
    ).rejects.toThrow('stream failed')

    expect(mocks.destroy).toHaveBeenCalledOnce()
    await expect(readFile(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('destroys the Agent when request fails before returning a response', async () => {
    mocks.request.mockRejectedValueOnce(new Error('connect failed'))

    await expect(
      downloadUrlMoext(
        'https://plugins.example/plugin.moext',
        path.join(tempDir, 'plugin.moext')
      )
    ).rejects.toThrow('connect failed')

    expect(mocks.destroy).toHaveBeenCalledOnce()
  })
})
