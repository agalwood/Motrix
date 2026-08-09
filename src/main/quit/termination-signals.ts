export type TerminationSignal = 'SIGINT' | 'SIGTERM'
export const DEV_SHUTDOWN_MESSAGE = 'motrix:dev-shutdown'

export interface TerminationSignalSource {
  on(
    signal: TerminationSignal,
    listener: (signal: TerminationSignal) => void
  ): void
  off(
    signal: TerminationSignal,
    listener: (signal: TerminationSignal) => void
  ): void
}

export interface DevShutdownMessageSource {
  on(event: 'message', listener: (message: unknown) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
}

export function registerTerminationSignalHandlers(
  onTermination: (signal: TerminationSignal) => void,
  source: TerminationSignalSource = process
): () => void {
  let handled = false

  const handle = (signal: TerminationSignal) => {
    if (handled) return
    handled = true
    onTermination(signal)
  }
  const handleSigint = () => handle('SIGINT')
  const handleSigterm = () => handle('SIGTERM')

  source.on('SIGINT', handleSigint)
  source.on('SIGTERM', handleSigterm)

  return () => {
    source.off('SIGINT', handleSigint)
    source.off('SIGTERM', handleSigterm)
  }
}

export function registerDevShutdownHandler(
  onTermination: () => void,
  source: DevShutdownMessageSource = process
): () => void {
  const handleMessage = (message: unknown) => {
    if (message === DEV_SHUTDOWN_MESSAGE) onTermination()
  }

  source.on('message', handleMessage)
  return () => source.off('message', handleMessage)
}
