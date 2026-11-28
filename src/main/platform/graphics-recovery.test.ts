// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GPU_FAILURE_WINDOW_MS, GraphicsRecovery } from './graphics-recovery'

describe('durable graphics recovery', () => {
  let directory: string
  let statePath: string
  let now: number
  const warn = vi.fn()
  const crash = { reason: 'crashed', exitCode: 139 }
  const open = (hardwareAcceleration = true) =>
    new GraphicsRecovery({
      statePath,
      hardwareAcceleration,
      warn,
      now: () => now,
    })

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'motrix-graphics-'))
    statePath = path.join(directory, 'graphics-recovery.json')
    now = 10_000
    warn.mockReset()
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('preserves explicit software mode without inventing a recovery notice', () => {
    expect(open().hardwareAcceleration).toBe(true)
    const software = open(false)
    expect(software.hardwareAcceleration).toBe(false)
    expect(software.recoveredAtStartup).toBe(false)
    expect(software.getNotice()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('persists consecutive GPU failures across hosts and disables only on the next startup', () => {
    open().recordFailure(crash)
    now += 1_000
    open().recordFailure({ reason: 'launch-failed', exitCode: 1002 })
    const current = open()
    expect(current.hardwareAcceleration).toBe(true)
    current.recordFailure(crash)
    expect(current.hardwareAcceleration).toBe(true)
    expect(current.getNotice()).toBeNull()
    current.markHealthy()

    const recovered = open()
    expect(recovered.hardwareAcceleration).toBe(false)
    expect(recovered.recoveredAtStartup).toBe(true)
    const notice = recovered.getNotice()
    expect(notice).toEqual({ id: expect.any(String) })
    // If startup dies before settings can be saved, keep recovery latched.
    expect(open().getNotice()).toEqual(notice)
    // Simulate successful persistence through SettingsManager.
    recovered.preferenceChanged(false)
    recovered.completeRecovery()
    expect(open(false).getNotice()).toEqual(notice)
    expect(open(false).recoveredAtStartup).toBe(false)
  })

  it('keeps software mode until the user explicitly enables acceleration again', () => {
    const current = open()
    for (let i = 0; i < 3; i++) current.recordFailure(crash)
    const recovered = open()
    recovered.completeRecovery()
    expect(open(false).hardwareAcceleration).toBe(false)
    recovered.preferenceChanged(true)
    // A settings change cannot change the already-running graphics mode.
    expect(recovered.hardwareAcceleration).toBe(false)
    expect(open(true).hardwareAcceleration).toBe(true)
    expect(open(true).getNotice()).toBeNull()
    open(true).recordFailure(crash)
    expect(open(true).hardwareAcceleration).toBe(true)
  })

  it('resets a partial streak after healthy operation', () => {
    const current = open()
    current.recordFailure(crash)
    current.recordFailure(crash)
    current.markHealthy()
    current.recordFailure(crash)
    expect(open().hardwareAcceleration).toBe(true)
  })

  it('does not accumulate failures separated by a long gap or clock rollback', () => {
    const current = open()
    current.recordFailure(crash)
    current.recordFailure(crash)
    now += GPU_FAILURE_WINDOW_MS + 1
    current.recordFailure(crash)
    expect(open().hardwareAcceleration).toBe(true)
    now = 1
    current.recordFailure(crash)
    expect(open().hardwareAcceleration).toBe(true)
  })

  it('records other exit reasons without attributing them to acceleration', () => {
    const current = open()
    for (const reason of [
      'clean-exit',
      'killed',
      'oom',
      'memory-eviction',
      'integrity-failure',
    ]) {
      current.recordFailure({ reason, exitCode: 0 })
    }
    current.recordFailure(crash)
    expect(open().hardwareAcceleration).toBe(true)
    const software = open(false)
    for (let i = 0; i < 20; i++) software.recordFailure(crash)
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(persisted.failures).toHaveLength(10)
    expect(persisted.recoveryPending).toBe(false)
  })

  it('keeps the notice durable until its exact id is acknowledged', () => {
    const current = open()
    for (let i = 0; i < 3; i++) current.recordFailure(crash)
    const recovered = open()
    recovered.completeRecovery()
    const notice = recovered.getNotice()!
    recovered.acknowledgeNotice('different-notice')
    expect(open(false).getNotice()).toEqual(notice)
    recovered.acknowledgeNotice(notice.id)
    expect(open(false).getNotice()).toBeNull()
  })

  it('honors a manual disable before a scheduled recovery', () => {
    const current = open()
    for (let i = 0; i < 3; i++) current.recordFailure(crash)
    current.preferenceChanged(false)
    expect(open(false).recoveredAtStartup).toBe(false)
    expect(open(false).getNotice()).toBeNull()
  })

  it('recovers malformed state without crashing or overriding an explicit disable', () => {
    writeFileSync(statePath, '{ broken')
    expect(open(false).hardwareAcceleration).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports a failed durable write without throwing from the GPU event', () => {
    const recovery = new GraphicsRecovery({
      statePath: path.join(directory, 'missing', 'state.json'),
      hardwareAcceleration: true,
      warn,
    })
    expect(() => recovery.recordFailure(crash)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
