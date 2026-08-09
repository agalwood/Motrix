import os from 'node:os'
import { natLogger } from './logger'

const log = natLogger('network-monitor')

export interface NetworkSnapshot {
  gatewayIp: string // Best-effort default gateway ('' if unknown)
  internalIp: string // Best-effort internal IP
  hash: string // Compared for equality across polls
}

export interface NetworkMonitorOptions {
  intervalMs?: number
  stableRounds?: number // Consecutive identical snapshots before emitting a change
  snapshotFn?: () => NetworkSnapshot // Injectable for tests
}

export const DEFAULT_INTERVAL_MS = 5000
export const DEFAULT_STABLE_ROUNDS = 2

export type NetworkChangeListener = (snapshot: NetworkSnapshot) => void

export class NetworkMonitor {
  private readonly intervalMs: number
  private readonly stableRounds: number
  private readonly snapshotFn: () => NetworkSnapshot
  private timer: NodeJS.Timeout | null = null
  private listeners = new Set<NetworkChangeListener>()
  private established: NetworkSnapshot | null = null
  private candidate: NetworkSnapshot | null = null
  private candidateCount = 0

  constructor(opts: NetworkMonitorOptions = {}) {
    this.intervalMs = Math.max(500, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.stableRounds = Math.max(1, opts.stableRounds ?? DEFAULT_STABLE_ROUNDS)
    this.snapshotFn = opts.snapshotFn ?? defaultSnapshotFn
  }

  onChange(listener: NetworkChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    this.poll()
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  snapshot(): NetworkSnapshot {
    try {
      return this.snapshotFn()
    } catch (err) {
      log.warn({ err }, 'snapshot failed')
      return { gatewayIp: '', internalIp: '', hash: '' }
    }
  }

  private poll(): void {
    let snap: NetworkSnapshot
    try {
      snap = this.snapshotFn()
    } catch (err) {
      log.warn({ err }, 'snapshot failed')
      return
    }
    if (!this.established) {
      this.established = snap
      return
    }
    if (snap.hash === this.established.hash) {
      this.candidate = null
      this.candidateCount = 0
      return
    }
    if (this.candidate && this.candidate.hash === snap.hash) {
      this.candidateCount++
    } else {
      this.candidate = snap
      this.candidateCount = 1
    }
    if (this.candidateCount >= this.stableRounds) {
      this.established = snap
      this.candidate = null
      this.candidateCount = 0
      for (const l of this.listeners) {
        try {
          l(snap)
        } catch (err) {
          log.warn({ err }, 'listener threw')
        }
      }
    }
  }
}

function defaultSnapshotFn(): NetworkSnapshot {
  const ifaces = os.networkInterfaces()
  let internalIp = ''
  let gatewayIp = ''
  // Best-effort: first IPv4 non-internal address. True default gateway
  // detection requires platform-specific calls; Phase 1 uses the presence
  // of interfaces as a proxy.
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        internalIp = addr.address
        // Derive probable gateway as .1 on the same /24 — heuristic;
        // NatManager re-discovers
        const parts = addr.address.split('.')
        if (parts.length === 4) {
          gatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`
        }
        break
      }
    }
    if (internalIp) break
  }
  return {
    gatewayIp,
    internalIp,
    hash: `${gatewayIp}|${internalIp}`,
  }
}
