import type { DownloadSubmitParams } from '@motrix/mdxp'
import { describe, expect, it } from 'vitest'
import type { RemoteBackendPolicyV1 } from '@/background/RemoteBackendPolicyStore'
import {
  applyRemoteSubmitPolicy,
  RemoteDataBoundaryConsentRequiredError,
} from '@/background/remote-submit-policy'

const params = (): DownloadSubmitParams => ({
  source: {
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Private title',
    detectedAt: 1,
  },
  selection: {
    kind: 'direct',
    primary: {
      url: 'https://cdn.example.com/video.mp4',
      headers: {
        Authorization: 'Bearer secret',
        Referer: 'https://example.com/watch',
        'X-Playback': 'allowed-only-with-header-consent',
      },
      cookies: [{ name: 'session', value: 'secret', domain: 'example.com' }],
      refererPolicy: 'strict-origin-when-cross-origin',
    },
  },
  meta: { suggestedFilename: 'video.mp4', qualityLabel: 'source' },
  idempotencyKey: 'remote-submit-key-123',
})

function policy(
  changes: Partial<RemoteBackendPolicyV1> = {}
): RemoteBackendPolicyV1 {
  return {
    version: 1,
    authorityKey: 'authority',
    authenticatedInstanceId: 'instance',
    remoteDataBoundaryAcceptedAt: 1,
    allowRequestCredentials: false,
    allowCustomHeaders: false,
    allowPageContent: false,
    allowServerUrlProbe: false,
    allowServerUrlResolve: false,
    allowAutomaticTakeover: false,
    ...changes,
  }
}

describe('remote download serialization policy', () => {
  it('blocks the entire submission until the user accepts the remote data boundary', () => {
    expect(() =>
      applyRemoteSubmitPolicy(
        params(),
        policy({ remoteDataBoundaryAcceptedAt: null })
      )
    ).toThrow(RemoteDataBoundaryConsentRequiredError)
  })

  it('strips cookies and every custom header by default without mutating the caller', () => {
    const original = params()
    const sanitized = applyRemoteSubmitPolicy(original, policy())
    if (
      original.selection.kind !== 'direct' ||
      sanitized.selection.kind !== 'direct'
    ) {
      throw new Error('test fixture kind changed')
    }
    expect(sanitized.selection.primary.headers).toEqual({})
    expect(sanitized.selection.primary.cookies).toEqual([])
    expect(sanitized.idempotencyKey).toBe('remote-submit-key-123')
    expect(original.selection.primary.headers).toHaveProperty('Authorization')
    expect(original.selection.primary.cookies).toHaveLength(1)
  })

  it('allows custom non-credential headers while retaining the credential deny gate', () => {
    const sanitized = applyRemoteSubmitPolicy(
      params(),
      policy({ allowCustomHeaders: true })
    )
    if (sanitized.selection.kind !== 'direct') {
      throw new Error('test fixture kind changed')
    }
    expect(sanitized.selection.primary.headers).toEqual({
      Referer: 'https://example.com/watch',
      'X-Playback': 'allowed-only-with-header-consent',
    })
    expect(sanitized.selection.primary.cookies).toEqual([])
  })

  it('includes credentials only after both relevant grants', () => {
    const sanitized = applyRemoteSubmitPolicy(
      params(),
      policy({ allowCustomHeaders: true, allowRequestCredentials: true })
    )
    if (sanitized.selection.kind !== 'direct') {
      throw new Error('test fixture kind changed')
    }
    expect(sanitized.selection.primary.headers.Authorization).toBe(
      'Bearer secret'
    )
    expect(sanitized.selection.primary.cookies).toHaveLength(1)
  })
})
