import type { PopupState } from '@/popup/usePopupState'
import { redactDiagnosticError } from '@/shared/connectionDiagnostics'

interface DiagnosticEnvironment {
  capturedAt: string
  extensionId: string
  extensionVersion: string
  build: string
  userAgent: string
  language: string
  nativeMessagingApi: boolean
}

export function buildConnectionDiagnostics(
  state: Pick<
    PopupState,
    'connection' | 'lastError' | 'lastErrorReason' | 'endpoint' | 'server'
  > &
    Partial<
      Pick<PopupState, 'backoff' | 'recoveryExhaustedUnattended' | 'rpc'>
    >,
  environment: DiagnosticEnvironment
): string {
  // Select fields explicitly: endpoint profiles and unrelated popup data do
  // not belong in a report intended to be pasted into a public issue.
  const report = {
    capturedAt: environment.capturedAt,
    extension: {
      id: environment.extensionId,
      version: environment.extensionVersion,
      build: environment.build,
    },
    environment: {
      userAgent: environment.userAgent,
      language: environment.language,
      nativeMessagingApi: environment.nativeMessagingApi,
    },
    connection: {
      backend:
        state.endpoint === null
          ? 'unknown'
          : state.endpoint.activeEndpointId === 'local'
            ? 'local'
            : 'remote',
      state: state.connection,
      ...(state.rpc
        ? {
            rpc: {
              health: state.rpc.health,
              lastSuccessAt: state.rpc.lastSuccessAt,
              lastError: state.rpc.lastError
                ? {
                    method: state.rpc.lastError.method,
                    at: state.rpc.lastError.at,
                    elapsedMs: state.rpc.lastError.elapsedMs,
                    generation: state.rpc.lastError.generation,
                  }
                : null,
            },
          }
        : {}),
      ...(state.backoff ? { retryAtMs: state.backoff.retryAtMs } : {}),
      ...(state.recoveryExhaustedUnattended
        ? { recoveryExhaustedUnattended: true }
        : {}),
      protocol: 'MBP1',
      app: state.server
        ? { version: state.server.version, runtime: state.server.runtime }
        : null,
      error: {
        reason: state.lastErrorReason,
        message:
          state.lastError === null
            ? null
            : redactDiagnosticError(state.lastError),
      },
    },
  }
  return `Motrix Extension connection diagnostics\n${JSON.stringify(report, null, 2)}`
}
