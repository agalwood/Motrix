import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub undici.request before importing the SUT.
const mockRequest = vi.fn()
vi.mock('undici', () => ({
  request: (...a: unknown[]) => mockRequest(...a),
}))

const { downloadGithubMoext, parseGithubSpec } = await import(
  './github-fetcher'
)

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'motrix-gh-'))
  mockRequest.mockReset()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function jsonResponse(payload: unknown, statusCode = 200) {
  return {
    statusCode,
    body: { json: async () => payload },
  }
}

function streamResponse(
  bytes: Buffer,
  statusCode = 200,
  headers: Record<string, string> = {}
) {
  return { statusCode, body: Readable.from(bytes), headers }
}

describe('parseGithubSpec', () => {
  it('parses owner/repo without tag', () => {
    expect(parseGithubSpec('acme/widget')).toEqual({
      owner: 'acme',
      repo: 'widget',
    })
  })

  it('parses owner/repo@tag', () => {
    expect(parseGithubSpec('acme/widget@v1.2.3')).toEqual({
      owner: 'acme',
      repo: 'widget',
      tag: 'v1.2.3',
    })
  })

  it('rejects malformed spec without slash', () => {
    expect(() => parseGithubSpec('no-slash')).toThrow(/invalid_github_spec/)
  })

  it('rejects whitespace in spec', () => {
    expect(() => parseGithubSpec('a b/c')).toThrow(/invalid_github_spec/)
  })
})

describe('downloadGithubMoext', () => {
  it('uses /releases/latest when no tag is provided', async () => {
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'v0.1.0',
          assets: [
            {
              name: 'widget-0.1.0.moext',
              browser_download_url: 'https://gh/assets/widget.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce(streamResponse(Buffer.from('zip-bytes-here')))

    const dest = path.join(tmp, 'widget.moext')
    const out = await downloadGithubMoext(
      { owner: 'acme', repo: 'widget' },
      dest
    )

    expect(out).toEqual({ tag: 'v0.1.0', assetName: 'widget-0.1.0.moext' })
    expect(mockRequest.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/acme/widget/releases/latest'
    )
    expect(mockRequest.mock.calls[1]?.[0]).toBe(
      'https://gh/assets/widget.moext'
    )
    expect((await readFile(dest)).toString()).toBe('zip-bytes-here')
  })

  it('uses /releases/tags/<tag> when a tag is provided', async () => {
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'v1.2.3',
          assets: [
            {
              name: 'widget-1.2.3.moext',
              browser_download_url: 'https://gh/assets/widget-1.2.3.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce(streamResponse(Buffer.from('bytes')))

    const dest = path.join(tmp, 'tagged.moext')
    await downloadGithubMoext(
      { owner: 'acme', repo: 'widget', tag: 'v1.2.3' },
      dest
    )
    expect(mockRequest.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/acme/widget/releases/tags/v1.2.3'
    )
  })

  it('URL-encodes a tag before putting it in the GitHub API path', async () => {
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'release/1',
          assets: [
            {
              name: 'widget.moext',
              browser_download_url: 'https://gh/assets/widget.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce(streamResponse(Buffer.from('bytes')))

    await downloadGithubMoext(
      { owner: 'acme', repo: 'widget', tag: 'release/1' },
      path.join(tmp, 'tagged-slash.moext')
    )
    expect(mockRequest.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/acme/widget/releases/tags/release%2F1'
    )
  })

  it('rejects when GitHub returns non-200', async () => {
    const destroy = vi.fn()
    mockRequest.mockResolvedValueOnce({
      statusCode: 404,
      body: { json: async () => ({ message: 'not found' }), destroy },
    })
    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.gh_release_unavailable: 404',
    })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('cancels the metadata body when JSON decoding fails', async () => {
    const destroy = vi.fn()
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => {
          throw new SyntaxError('invalid JSON')
        },
        destroy,
      },
    })

    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toThrow('invalid JSON')

    expect(destroy).toHaveBeenCalledOnce()
  })

  it('rejects when no asset ends with .moext', async () => {
    mockRequest.mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.1.0',
        assets: [
          {
            name: 'source.zip',
            browser_download_url: 'https://gh/assets/source.zip',
          },
        ],
      })
    )
    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({ message: 'plugin.install.no_moext_asset' })
  })

  it('rejects when asset download itself fails', async () => {
    const failedBody = Readable.from(Buffer.alloc(0))
    const once = vi.spyOn(failedBody, 'once')
    const destroy = vi.spyOn(failedBody, 'destroy')
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'v0.1.0',
          assets: [
            {
              name: 'x.moext',
              browser_download_url: 'https://gh/assets/x.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce({ statusCode: 500, body: failedBody, headers: {} })
    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.gh_asset_download_failed: 500',
    })
    expect(once).toHaveBeenCalledWith('error', expect.any(Function))
    expect(destroy).toHaveBeenCalledOnce()
    expect(once.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0] as number
    )
  })

  it('cancels a failing asset stream and removes any destination file', async () => {
    let emitted = false
    const failedBody = new Readable({
      read() {
        if (emitted) return
        emitted = true
        this.push(Buffer.from('partial'))
        this.destroy(new Error('asset stream failed'))
      },
    })
    const destroy = vi.spyOn(failedBody, 'destroy')
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'v0.1.0',
          assets: [
            {
              name: 'x.moext',
              browser_download_url: 'https://gh/assets/x.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce({
        statusCode: 200,
        body: failedBody,
        headers: {},
      })
    const destination = path.join(tmp, 'x.moext')

    await expect(
      downloadGithubMoext({ owner: 'acme', repo: 'widget' }, destination)
    ).rejects.toThrow('asset stream failed')

    expect(destroy).toHaveBeenCalled()
    await expect(readFile(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects an insecure GitHub asset URL before downloading it', async () => {
    mockRequest.mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'x.moext',
            browser_download_url: 'http://assets.example/x.moext',
          },
        ],
      })
    )

    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget', tag: 'v1.0.0' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.gh_asset_insecure_url',
    })
    expect(mockRequest).toHaveBeenCalledOnce()
  })

  it('rejects a GitHub asset redirect that downgrades HTTPS', async () => {
    mockRequest
      .mockResolvedValueOnce(
        jsonResponse({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'x.moext',
              browser_download_url: 'https://assets.example/x.moext',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        streamResponse(Buffer.alloc(0), 302, {
          location: 'http://cdn.example/x.moext',
        })
      )

    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget', tag: 'v1.0.0' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.redirect_protocol_downgrade',
    })
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('rejects a GitHub asset after five redirects', async () => {
    mockRequest.mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'x.moext',
            browser_download_url: 'https://assets.example/x.moext',
          },
        ],
      })
    )
    for (let hop = 0; hop < 6; hop += 1) {
      mockRequest.mockResolvedValueOnce(
        streamResponse(Buffer.alloc(0), 302, {
          location: `https://cdn.example/hop-${hop}.moext`,
        })
      )
    }

    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget', tag: 'v1.0.0' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.too_many_redirects',
    })
    expect(mockRequest).toHaveBeenCalledTimes(7)
  })
})
