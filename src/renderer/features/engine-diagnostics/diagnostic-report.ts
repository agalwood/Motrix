import type {
  EngineDiagnosticReport,
  EngineProcessInfo,
} from '@shared/types/engine'

// Error messages are already sanitized by the engine. Cover credential-shaped
// text and home directories again when producing a report intended for sharing.
function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer\s+|token:)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:--)?(?:rpc-secret|all-proxy(?:-user|-passwd)?|password|passwd|token|api[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]'
    )
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '[home]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '[home]')
}

function processSnapshot(process: EngineProcessInfo | null) {
  return process
    ? {
        pid: process.pid,
        name: redactDiagnosticText(process.name),
        executableName: process.executableName
          ? redactDiagnosticText(process.executableName)
          : null,
        ownership: process.ownership,
        safeToTerminate: process.safeToTerminate,
      }
    : null
}

export function formatEngineDiagnostics(
  report: EngineDiagnosticReport
): string {
  // Explicit fields keep future transport additions out of clipboard exports.
  return JSON.stringify(
    {
      schemaVersion: 1,
      application: {
        name: __MOTRIX_APP_METADATA__.name,
        version: __MOTRIX_APP_METADATA__.version,
        target: __MOTRIX_TARGET__,
      },
      generatedAt: new Date(report.generatedAt).toISOString(),
      state: report.state,
      managedPid: report.managedPid,
      binary: {
        name: redactDiagnosticText(report.binary.name),
        available: report.binary.available,
        version: report.binary.version,
      },
      featureReport: report.featureReport
        ? {
            version: report.featureReport.version,
            features: report.featureReport.features,
            hasBtSeedUnverified: report.featureReport.hasBtSeedUnverified,
            hasBtSaveMetadata: report.featureReport.hasBtSaveMetadata,
            hasMoveStorage: report.featureReport.hasMoveStorage,
            hasSqlitePersistence: report.featureReport.hasSqlitePersistence,
          }
        : null,
      rpc: {
        port: report.rpc.port,
        available: report.rpc.available,
        expectedListener: report.rpc.expectedListener,
        connection: report.rpc.connection
          ? {
              transport: report.rpc.connection.transport,
              connected: report.rpc.connection.connected,
            }
          : null,
      },
      process: processSnapshot(report.process),
      defaultRpc: {
        port: report.defaultRpc.port,
        isCurrent: report.defaultRpc.isCurrent,
        available: report.defaultRpc.available,
        process: processSnapshot(report.defaultRpc.process),
        canRestore: report.defaultRpc.canRestore,
        requiresTermination: report.defaultRpc.requiresTermination,
      },
      failure: report.failure
        ? {
            reason: report.failure.reason,
            occurredAt: new Date(report.failure.occurredAt).toISOString(),
            technicalMessage: report.failure.technicalMessage
              ? redactDiagnosticText(report.failure.technicalMessage)
              : null,
          }
        : null,
      recommendation: report.recommendation,
      suggestedRpcPort: report.suggestedRpcPort,
      canRetry: report.canRetry,
      canForceTerminate: report.canForceTerminate,
      canSwitchPort: report.canSwitchPort,
    },
    null,
    2
  )
}
