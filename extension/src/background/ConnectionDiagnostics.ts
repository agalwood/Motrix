import { createBootstrapProvider } from '@/background/createBootstrapProvider'
import {
  type EndpointConfig,
  resolveActiveEndpoint,
} from '@/background/EndpointConfigStore'
import { log } from '@/background/log'
import {
  isExtensionPageSender,
  type ManualTaskMessageSender,
} from '@/background/manualTask'
import { deriveRemoteBridgeRoute } from '@/background/mbp1/bridge-route'
import { readDiscoveryDoc } from '@/background/mbp1/discovery-service'
import { hasLoopbackPermission } from '@/background/mbp1/permission-gate'
import { RemoteDiscoveryService } from '@/background/mbp1/remote-discovery-service'
import { NativeBootstrapError } from '@/background/NativeBootstrap'
import { pairingAuthorityForEndpoint } from '@/background/PairingEndpointService'
import { extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser, requireProtocolBrowser } from '@/shared/browserKind'
import {
  type ConnectionDiagnosticResult,
  type DiagnosticCheck,
  diagnosticDeadline,
  redactDiagnosticError,
} from '@/shared/connectionDiagnostics'
import { setLogLevel } from '@/shared/logLevel'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'
import { SAFARI_EXTENSION_ID } from '@/shared/safariNative'

interface Dependencies {
  getConfig: () => Promise<EndpointConfig>
  getPairingStatus: (endpointId: string) => Promise<{ paired: boolean }>
}

type Finding = Pick<DiagnosticCheck, 'status' | 'detail'>
const NATIVE_HOST = 'app.motrix.bridge'

export function nativeHostFailure(error: unknown): Finding {
  const message =
    error instanceof Error ? error.message : 'Unknown native host error'
  let advice: string
  if (
    /forbidden|not allowed|permission.*denied|access.*denied/i.test(message)
  ) {
    advice =
      'The browser denied native-host access. Check this extension ID in the native-host allowlist and browser/enterprise policy. The extension cannot read the installed manifest.'
  } else if (
    /not found|no such native application|not-installed/i.test(message)
  ) {
    advice =
      'The native host was not found for this browser. Open Motrix and repair/re-enable browser integration; verify the host registration and executable path.'
  } else if (
    error instanceof NativeBootstrapError &&
    error.code === 'host-error:not-running'
  ) {
    return {
      status: 'warn',
      detail:
        'Native host answered: Motrix is not running. Open Motrix and retry Connect. This diagnostic used allowLaunch=false.',
    }
  } else if (/failed to start|launch-failed/i.test(message)) {
    advice =
      'Check the registered executable path, executable permissions and Motrix installation.'
  } else if (/timeout|timed out/i.test(message)) {
    advice =
      'The native host did not answer within 4 seconds. Check for a stuck host process or stale browser-integration registration.'
  } else {
    advice =
      'Check native-host registration and browser background-console errors. This error alone does not establish an allowlist problem.'
  }
  return {
    status: 'fail',
    detail: `${redactDiagnosticError(message)}\n${advice}`,
  }
}

/** GET only: no WebSocket, pairing, credential writes, or nonce requests. */
async function probePort(port: number): Promise<Finding> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/discovery`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
    if (!response.ok)
      return {
        status: 'warn',
        detail: `HTTP ${response.status}; a listener exists, but it did not return a usable discovery document.`,
      }
    // A different local process can own the port. Bound its response and only
    // publish selected parsed fields, never the body or its instance identity.
    const reader = response.body?.getReader()
    if (!reader) return { status: 'warn', detail: 'Empty discovery response.' }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024)
          return {
            status: 'warn',
            detail:
              'Discovery response exceeds 64 KiB; possible port conflict.',
          }
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return {
        status: 'warn',
        detail: 'Invalid discovery JSON; possible port conflict.',
      }
    }
    const candidate = readDiscoveryDoc(port, body)
    if (!candidate)
      return {
        status: 'warn',
        detail:
          'Not a Motrix discovery document; possible port conflict or incompatible App.',
      }
    return {
      status: candidate.compatibility === 'compatible' ? 'pass' : 'fail',
      detail: `Motrix discovery: appVersion=${JSON.stringify(candidate.appVersion)}, compatibility=${candidate.compatibility}. Unauthenticated hint; pairing has not been tested.`,
    }
  } catch {
    return {
      status: 'warn',
      detail: controller.signal.aborted
        ? 'Discovery timed out after 1500 ms.'
        : 'Discovery unavailable: connection refused, blocked, redirected, or interrupted. This does not prove Motrix is uninstalled.',
    }
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
}

export async function runConnectionDiagnostics(
  deps: Dependencies,
  expectedEndpointId: string | null
): Promise<ConnectionDiagnosticResult> {
  requireProtocolBrowser(getBuildBrowser())
  const started = Date.now()
  const config = await diagnosticDeadline(deps.getConfig(), 1000)
  if (
    expectedEndpointId !== null &&
    config.activeEndpointId !== expectedEndpointId
  )
    throw new Error('Selected backend changed. Run diagnostics again.')
  const endpoint = resolveActiveEndpoint(config)
  const checks: DiagnosticCheck[] = []
  async function check(id: string, run: () => Promise<Finding>): Promise<void> {
    const at = Date.now()
    let finding: Finding
    try {
      finding = await diagnosticDeadline(run(), 6000)
    } catch (error) {
      finding = {
        status: 'fail',
        detail: redactDiagnosticError(
          error instanceof Error ? error.message : 'Check failed'
        ),
      }
    }
    const result = { id, ...finding, durationMs: Date.now() - at }
    checks.push(result)
    log.debug('[connection-diagnostics]', result)
  }
  await check('debug-log', async () => {
    await diagnosticDeadline(setLogLevel('debug'), 1000)
    log.setLevel('debug')
    return {
      status: 'pass',
      detail:
        'Debug logging enabled. Reproduce the connection failure to collect subsequent background-console logs. Restore the log level in Settings > Help when finished.',
    }
  })
  await check('installation', async () => {
    if (typeof browser.management?.getSelf !== 'function')
      return {
        status: 'warn',
        detail:
          'installType=unknown; management.getSelf is unavailable. Build variant does not establish installation type.',
      }
    const self = await diagnosticDeadline(browser.management.getSelf(), 1000)
    if (!self.installType)
      return {
        status: 'warn',
        detail:
          'installType=unknown. The browser did not report the installation type.',
      }
    return {
      status: self.installType === 'development' ? 'warn' : 'pass',
      detail: `installType=${self.installType ?? 'unknown'}; unpackedDevelopmentInstall=${self.installType === 'development'}. This does not indicate whether DevTools is open. No management permission is required for getSelf().`,
    }
  })
  await check('stored-pairing', async () => {
    const { paired } = await diagnosticDeadline(
      deps.getPairingStatus(config.activeEndpointId),
      1000
    )
    return {
      status: paired ? 'pass' : 'warn',
      detail: paired
        ? 'A committed credential exists for this extension installation and selected backend. Server acceptance is not tested.'
        : 'No committed credential for this installation and backend. Use Connect to pair; changing an unpacked extension ID creates a different identity.',
    }
  })
  if (endpoint.mode === 'local') {
    await check('extension-allowlist', async () => ({
      status: 'warn',
      detail:
        getBuildBrowser() === 'safari'
          ? `Safari native client: ${SAFARI_EXTENSION_ID}. The signed containing extension and Motrix bootstrap service must share their configured Team and App Group. The native service verifies both peers; a browser-reported UUID or bundle ID alone does not prove identity.`
          : `Check Motrix Settings > Integration > trusted extensions for this ID: ${browser.runtime.id}\nNative host: ${NATIVE_HOST}\n${browser.runtime.getURL('').startsWith('moz-extension:') ? `allowed_extensions must include ${JSON.stringify(browser.runtime.id)}` : `allowed_origins must include ${JSON.stringify(`chrome-extension://${browser.runtime.id}/`)}`}\nThe App trust registry and browser native-host manifest are separate checks. Their contents cannot be read by this extension.`,
    }))
    await check('loopback-permission', async () => {
      const granted = await diagnosticDeadline(hasLoopbackPermission(), 1000)
      return {
        status: granted ? 'pass' : 'fail',
        detail: granted
          ? 'Host permission covers http://127.0.0.1/*.'
          : 'Loopback host permission is missing. Allow extension site access before retrying.',
      }
    })
    let nativePort: number | undefined
    await check('native-host', async () => {
      if (!hasNativeMessagingSupport())
        return {
          status: 'fail',
          detail:
            'The required Native Messaging API or packaged permission is unavailable in this browser/context.',
        }
      try {
        // The existing host protocol has no ping. A launch-disabled legacy
        // bootstrap may mint one unused nonce; discard it without pairing.
        const reply = await createBootstrapProvider(getBuildBrowser(), {
          timeoutMs: 4000,
        }).discover({
          allowLaunch: false,
        })
        nativePort = reply.wsPort
        return {
          status: reply.protocolVersion === 1 ? 'pass' : 'warn',
          detail: `Host answered: port=${reply.wsPort}, protocolVersion=${reply.protocolVersion}, allowLaunch=false. Browser native-host access succeeded; App MBP1 admission remains untested. Any bootstrap nonce was discarded.`,
        }
      } catch (error) {
        return nativeHostFailure(error)
      }
    })
    const ports = [
      ...new Set([
        16802,
        16803,
        16804,
        16805,
        16806,
        ...(nativePort ? [nativePort] : []),
      ]),
    ]
    await Promise.all(
      ports.map((port) => check(`discovery:${port}`, () => probePort(port)))
    )
    await check('local-summary', async () => {
      const reachable = checks.filter(
        (c) => c.id.startsWith('discovery:') && c.status === 'pass'
      )
      return reachable.length > 0
        ? {
            status: 'pass',
            detail: `Compatible discovery responders: ${reachable.length}. If Connect still fails, inspect the original error, App trust registry, pairing prompt, backoff and background debug logs. Discovery does not authenticate the App.`,
          }
        : {
            status: 'fail',
            detail:
              'No compatible bridge responded. Open Motrix, enable browser integration, check the discovery results for port conflicts or upgrade requirements, then retry Connect.',
          }
    })
  } else {
    await check('native-host', async () => ({
      status: 'skip',
      detail:
        'Remote backend selected; Native Messaging and local port scans do not apply.',
    }))
    await check('remote-discovery', async () => {
      const authority = pairingAuthorityForEndpoint(endpoint)
      if (authority.kind !== 'remote')
        throw new Error('Expected remote backend')
      const result = await new RemoteDiscoveryService({
        timeoutMs: 4000,
      }).discover(deriveRemoteBridgeRoute(authority))
      if (result.status === 'unavailable')
        return {
          status: 'fail',
          detail: `Remote discovery: ${result.detail}; HTTP=${result.httpStatus ?? 'unknown'}. Check the configured URL, server availability, TLS certificate, proxy and extension site access.`,
        }
      return {
        status: result.status === 'compatible' ? 'pass' : 'fail',
        detail: `Remote discovery: ${result.status}; appVersion=${JSON.stringify(result.untrustedDocument.appVersion)}${result.status === 'incompatible' ? `; ${result.reason}` : ''}. Unauthenticated hint; no nonce or pairing request was sent.`,
      }
    })
  }
  await check('backend-snapshot', async () => {
    const current = await diagnosticDeadline(deps.getConfig(), 1000)
    return current.activeEndpointId === config.activeEndpointId &&
      JSON.stringify(resolveActiveEndpoint(current)) ===
        JSON.stringify(endpoint)
      ? {
          status: 'pass',
          detail: 'Selected backend unchanged during this run.',
        }
      : {
          status: 'fail',
          detail:
            'Selected backend changed during diagnostics. These results describe the previous selection; run again.',
        }
  })
  return {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    backend: endpoint.mode,
    checks,
  }
}

/** Only extension UI may enable logging or actively probe endpoints. */
export function createConnectionDiagnosticsHandler(deps: Dependencies) {
  let pending: Promise<ConnectionDiagnosticResult> | undefined
  let pendingEndpoint: string | null = null
  return (
    request: { endpointId: string | null },
    sender: ManualTaskMessageSender
  ): Promise<ConnectionDiagnosticResult> => {
    if (
      !isExtensionPageSender(
        sender,
        browser.runtime.id,
        browser.runtime.getURL('')
      )
    )
      return Promise.reject(new Error('diagnostics.forbidden'))
    if (
      !request ||
      (request.endpointId !== null && typeof request.endpointId !== 'string')
    )
      return Promise.reject(new Error('diagnostics.invalid-request'))
    if (pending)
      return pendingEndpoint === request.endpointId
        ? pending
        : Promise.reject(
            new Error('Diagnostics are already running for another backend.')
          )
    pendingEndpoint = request.endpointId
    pending = runConnectionDiagnostics(deps, request.endpointId).finally(() => {
      pending = undefined
    })
    return pending
  }
}
