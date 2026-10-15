import type { DownloadSubmitParams, Resource } from '@motrix/mdxp'
import type { RemoteBackendPolicyV1 } from '@/background/RemoteBackendPolicyStore'

const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
])

export class RemoteDataBoundaryConsentRequiredError extends Error {
  readonly reason = 'permissionRequired'

  constructor() {
    super('remote download data boundary consent is required')
    this.name = 'RemoteDataBoundaryConsentRequiredError'
  }
}

export class RemoteAutomaticTakeoverConsentRequiredError extends Error {
  readonly reason = 'permissionRequired'

  constructor() {
    super('automatic browser-download takeover is not allowed for this Server')
    this.name = 'RemoteAutomaticTakeoverConsentRequiredError'
  }
}

function sanitizeResource(
  resource: Resource,
  policy: RemoteBackendPolicyV1
): Resource {
  const headers = policy.allowCustomHeaders
    ? Object.fromEntries(
        Object.entries(resource.headers).filter(
          ([name]) =>
            policy.allowRequestCredentials ||
            !CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())
        )
      )
    : {}
  return {
    ...resource,
    headers,
    cookies: policy.allowRequestCredentials
      ? resource.cookies.map((cookie) => ({ ...cookie }))
      : [],
  }
}

/** Enforce the remote data boundary at the last outbound serialization seam.
 * Pairing alone never authorizes a page-derived submission. The returned
 * object is detached from caller-owned resources so later mutation cannot add
 * credentials after this check. */
export function applyRemoteSubmitPolicy(
  params: DownloadSubmitParams,
  policy: RemoteBackendPolicyV1
): DownloadSubmitParams {
  if (policy.remoteDataBoundaryAcceptedAt === null) {
    throw new RemoteDataBoundaryConsentRequiredError()
  }

  const selection = params.selection
  if (selection.kind === 'magnet') {
    return {
      ...params,
      source: { ...params.source },
      meta: { ...params.meta },
      selection: { ...selection },
    }
  }
  if (selection.kind === 'mux') {
    return {
      ...params,
      source: { ...params.source },
      meta: { ...params.meta },
      selection: {
        ...selection,
        video: sanitizeResource(selection.video, policy),
        audio: sanitizeResource(selection.audio, policy),
      },
    }
  }
  return {
    ...params,
    source: { ...params.source },
    meta: { ...params.meta },
    selection: {
      ...selection,
      primary: sanitizeResource(selection.primary, policy),
    },
  }
}
