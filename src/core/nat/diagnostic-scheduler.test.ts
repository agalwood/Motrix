import { DEFAULT_NAT_SETTINGS } from '@shared/schemas/nat-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticScheduler } from './diagnostic-scheduler'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const settings = {
    ...DEFAULT_NAT_SETTINGS,
    autoDiagnostic: true,
    natTypeDetectionEnabled: true,
    stunServers: ['stun.example.com:3478'],
    diagnosticIntervalSec: 300,
  }
  const run = vi.fn(async (_signal: AbortSignal) => {})
  const error = vi.fn()
  const scheduler = new DiagnosticScheduler(() => settings, run, error)
  return { settings, run, error, scheduler }
}
describe('Network diagnostic scheduling', () => {
  it('runs at the saved interval and stops all future checks', async () => {
    const { scheduler, run } = fixture()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(299999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledOnce()
    await scheduler.stop()
    await vi.advanceTimersByTimeAsync(600000)
    expect(run).toHaveBeenCalledOnce()
  })
  it('does not run when automatic checks or both diagnostic types are off', async () => {
    const { scheduler, run, settings } = fixture()
    settings.autoDiagnostic = false
    scheduler.start()
    await vi.advanceTimersByTimeAsync(300000)
    expect(run).not.toHaveBeenCalled()
    settings.autoDiagnostic = true
    settings.natTypeDetectionEnabled = false
    settings.portReachabilityCheckEnabled = false
    scheduler.refresh()
    await vi.advanceTimersByTimeAsync(300000)
    expect(run).not.toHaveBeenCalled()
    await scheduler.stop()
  })
  it('aborts an in-flight check on changes and never overlaps its replacement', async () => {
    const { scheduler, run, settings } = fixture()
    let finish!: () => void
    run.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    scheduler.start()
    await vi.advanceTimersByTimeAsync(300000)
    const signal = run.mock.calls[0][0]
    settings.diagnosticIntervalSec = 600
    scheduler.refresh()
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(600000)
    expect(run).toHaveBeenCalledOnce()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    await scheduler.stop()
  })
  it('does not reset the timer for unrelated settings events and recovers after errors', async () => {
    const { scheduler, run, error } = fixture()
    run.mockRejectedValueOnce(Error('offline'))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(150000)
    scheduler.refresh()
    await vi.advanceTimersByTimeAsync(150000)
    expect(error).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(300000)
    expect(run).toHaveBeenCalledTimes(2)
    await scheduler.stop()
  })
})
