import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub undici.request before importing the SUT. downloadGithubMoext also
// composes a redirect-following dispatcher (undici v8 moved maxRedirections
// out of request() options); the mocked request ignores the dispatcher, so a
// structural stub for Agent/interceptors is enough.
const mockRequest = vi.fn()
vi.mock('undici', () => ({
  request: (...a: unknown[]) => mockRequest(...a),
  Agent: class {
    compose() {
      return {}
    }
  },
  interceptors: { redirect: () => ({}) },
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

function streamResponse(bytes: Buffer, statusCode = 200) {
  return { statusCode, body: Readable.from(bytes) }
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

  it('rejects when GitHub returns non-200', async () => {
    mockRequest.mockResolvedValueOnce(
      jsonResponse({ message: 'not found' }, 404)
    )
    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.gh_release_unavailable: 404',
    })
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
      .mockResolvedValueOnce(streamResponse(Buffer.alloc(0), 500))
    await expect(
      downloadGithubMoext(
        { owner: 'acme', repo: 'widget' },
        path.join(tmp, 'x.moext')
      )
    ).rejects.toMatchObject({
      message: 'plugin.install.gh_asset_download_failed: 500',
    })
  })
})
