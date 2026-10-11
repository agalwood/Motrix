import { randomUUID } from 'node:crypto'
import { Events } from '@shared/protocol/events'
import type {
  RendererCapability,
  RendererFailure,
  RendererProbeReply,
  RendererSurface,
  RendererSurfaceReport,
} from '@shared/schemas/renderer-health'
import type { WindowId } from '@shared/types/window'
import type { BrowserWindow, WebContents } from 'electron'
import {
  classifyRendererExit,
  RendererRecoveryBudget,
  RENDERER_RECOVERY_TIMING as timing,
} from './renderer-recovery-policy'
import type { WindowLifecycle, WindowLifecycleReason } from './window-lifecycle'

export type RendererPhase =
  | 'absent'
  | 'booting'
  | 'ready'
  | 'suspect'
  | 'recovering'
  | 'deferred'
  | 'blocked'
  | 'disposed'

export interface RendererIncident {
  generation: string
  incidentId: string
  windowId: WindowId
  phase: RendererPhase
  reason: string
  attempt: number
}

interface Slot {
  id: WindowId
  win: BrowserWindow | null
  generation: string
  phase: RendererPhase
  surface: RendererSurface
  capabilities: Set<RendererCapability>
  documentVisible: boolean
  requestedShow: boolean
  route?: string
  bootDeadline: number
  nextProbe: number
  probe?: { id: string; deadline: number }
  misses: number
  suspectSince?: number
  stableSince?: number
  incidentId: string
  reason: string
  attempt: number
  recoveryDue?: number
  manual: boolean
  recovered: boolean
  promptShown: boolean
  hangReported: boolean
  nativeFallback: boolean
  cleanup: (() => void)[]
}

export interface RendererSupervisorDeps {
  mode: 'observe' | 'recover'
  reload(id: WindowId): void
  recreate(id: WindowId, show?: boolean): void
  report(incident: RendererIncident): void
  prompt(incident: RendererIncident): void
  capabilitiesChanged?(id: WindowId): void
  normalizeRoute?(route: string): string | undefined
  now?: () => number
}

/** Owns renderer health only. It deliberately has no download/engine dependency. */
export class RendererSupervisor implements WindowLifecycle {
  private readonly slots = new Map<WindowId, Slot>()
  private readonly now: () => number
  private readonly budget: RendererRecoveryBudget
  private timer: ReturnType<typeof setInterval> | undefined
  private lastTick: number
  private stopped = false
  private suspended = false
  private locked = false
  private modalDepth = 0
  private graceUntil = 0
  private memoryPressure = false

  constructor(private readonly deps: RendererSupervisorDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.lastTick = this.now()
    this.budget = new RendererRecoveryBudget(this.now)
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => this.tick(), 1_000)
    this.timer.unref?.()
  }

  get canPrewarm(): boolean {
    return !this.stopped && !this.memoryPressure
  }

  created(id: WindowId, win: BrowserWindow, show: boolean): void {
    if (this.stopped) return
    const previous = this.slots.get(id)
    previous?.cleanup.forEach((dispose) => {
      dispose()
    })
    const now = this.now()
    const slot: Slot = {
      id,
      win,
      generation: randomUUID(),
      phase: 'booting',
      surface: 'boot',
      capabilities: new Set(),
      documentVisible: true,
      requestedShow: show,
      bootDeadline: now + timing.boot,
      nextProbe: now + timing.probeInterval,
      misses: 0,
      incidentId: previous?.incidentId ?? randomUUID(),
      reason: previous?.reason ?? '',
      attempt: previous?.attempt ?? 0,
      manual: previous?.manual ?? false,
      recovered: previous?.recovered ?? false,
      promptShown: false,
      hangReported: false,
      nativeFallback: false,
      route: previous?.route,
      cleanup: [],
    }
    this.slots.set(id, slot)
    const wc = win.webContents
    const onNavigation = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean
    ) => {
      if (mainFrame && !inPlace && this.current(slot)) this.beginDocument(slot)
    }
    const onInPageNavigation = (
      _event: unknown,
      url: string,
      mainFrame: boolean
    ) => {
      if (id !== 'main' || !mainFrame || !this.current(slot)) return
      // React Router uses pushState/replaceState, which do not emit hashchange.
      // Electron observes these committed navigations as well as back/forward.
      const route = new URL(url).hash.slice(1) || '/'
      slot.route = this.deps.normalizeRoute?.(route)
    }
    const onGone = (
      _event: unknown,
      details: { reason: string; exitCode: number }
    ) => {
      if (!this.current(slot)) return
      this.exited(slot, details.reason)
    }
    const onLoadFailure = (
      _event: unknown,
      code: number,
      _description: string,
      _url: string,
      mainFrame: boolean
    ) => {
      // Cancelled navigations are also represented by the owned load promise.
      // WindowManager discards its superseded promises by load revision.
      if (mainFrame && code !== -3 && this.current(slot)) {
        this.block(slot, 'load-failed')
      }
    }
    const onPreload = () => {
      if (this.current(slot)) this.block(slot, 'preload-failed')
    }
    const onUnresponsive = () => {
      if (this.current(slot) && this.eligible(slot)) this.suspect(slot)
    }
    const onResponsive = () => {
      if (this.current(slot)) this.probe(slot)
    }
    const onShow = () => this.shown(id)
    const onHide = () => {
      slot.requestedShow = false
      slot.stableSince = undefined
      this.clearProbe(slot)
    }
    wc.on('did-start-navigation', onNavigation)
    wc.on('did-navigate-in-page', onInPageNavigation)
    wc.on('render-process-gone', onGone)
    wc.on('did-fail-load', onLoadFailure)
    wc.on('preload-error', onPreload)
    wc.on('unresponsive', onUnresponsive)
    wc.on('responsive', onResponsive)
    win.on('show', onShow)
    win.on('restore', onShow)
    win.on('focus', onShow)
    win.on('hide', onHide)
    win.on('minimize', onHide)
    slot.cleanup.push(() => {
      wc.off('did-start-navigation', onNavigation)
      wc.off('did-navigate-in-page', onInPageNavigation)
      wc.off('render-process-gone', onGone)
      wc.off('did-fail-load', onLoadFailure)
      wc.off('preload-error', onPreload)
      wc.off('unresponsive', onUnresponsive)
      wc.off('responsive', onResponsive)
      win.off('show', onShow)
      win.off('restore', onShow)
      win.off('focus', onShow)
      win.off('hide', onHide)
      win.off('minimize', onHide)
    })
  }

  released(id: WindowId, reason: WindowLifecycleReason): void {
    const slot = this.slots.get(id)
    if (!slot) return
    slot.cleanup.forEach((dispose) => {
      dispose()
    })
    slot.cleanup = []
    slot.win = null
    slot.generation = randomUUID()
    slot.capabilities.clear()
    slot.recoveryDue = undefined
    this.clearProbe(slot)
    slot.phase = reason === 'shutdown' ? 'disposed' : 'absent'
    if (reason !== 'recovery' && reason !== 'configuration') {
      slot.manual = false
      slot.recovered = false
      slot.route = undefined
    }
    this.deps.capabilitiesChanged?.(id)
  }

  dismissed(id: WindowId): void {
    const slot = this.slots.get(id)
    if (!slot) return
    slot.requestedShow = false
    slot.recoveryDue = undefined
    this.clearProbe(slot)
    if (slot.phase === 'recovering') slot.phase = 'deferred'
  }

  shown(id: WindowId): void {
    const slot = this.slots.get(id)
    if (!slot || !this.current(slot)) return
    slot.requestedShow = true
    slot.documentVisible = true
    if (slot.phase === 'deferred') {
      this.scheduleRecovery(slot)
    } else if (slot.phase === 'blocked' && slot.nativeFallback) {
      this.prompt(slot)
    } else if (slot.phase === 'ready' || slot.phase === 'suspect') {
      this.probe(slot)
    }
  }

  loadFailed(id: WindowId, win: BrowserWindow): void {
    const slot = this.slots.get(id)
    if (slot?.win === win && this.current(slot)) this.block(slot, 'load-failed')
  }

  session(sender: WebContents): {
    generation: string
    windowId: WindowId
    route?: string
    recovered: boolean
  } {
    const slot = this.senderSlot(sender)
    return {
      generation: slot.generation,
      windowId: slot.id,
      route: slot.route,
      recovered: slot.recovered,
    }
  }

  validate(sender: WebContents, generation: string): WindowId {
    const slot = this.senderSlot(sender)
    if (slot.generation !== generation)
      throw new Error('Stale renderer session')
    return slot.id
  }

  reportSurface(sender: WebContents, report: RendererSurfaceReport): void {
    const id = this.validate(sender, report.generation)
    const slot = this.slots.get(id)
    if (!slot) return
    slot.surface = report.surface
    slot.documentVisible = report.documentVisible
    slot.capabilities = new Set(report.capabilities)
    if (id === 'main' && report.route) {
      slot.route = this.deps.normalizeRoute?.(report.route)
    }
    if (
      report.surface === 'route-error' ||
      (report.surface === 'app' &&
        (id === 'onboarding' ||
          slot.capabilities.has(
            id === 'main' ? 'navigation' : 'add-task-hydration'
          )))
    ) {
      if (slot.phase === 'booting' || slot.phase === 'suspect') {
        this.markReady(slot)
      }
    } else if (report.surface === 'fatal-fallback') {
      this.block(slot, 'render-failed', false)
    }
    if (!report.documentVisible) {
      slot.stableSince = undefined
      this.clearProbe(slot)
    }
    this.deps.capabilitiesChanged?.(id)
  }

  acknowledge(sender: WebContents, report: RendererProbeReply): void {
    const id = this.validate(sender, report.generation)
    const slot = this.slots.get(id)
    if (!slot || slot.probe?.id !== report.challengeId) return
    // A late response cannot acknowledge a newer probe or erase its timeout.
    if (this.now() > slot.probe.deadline) return
    slot.probe = undefined
    slot.documentVisible = report.documentVisible
    slot.surface = report.surface
    if (!report.documentVisible) {
      this.clearProbe(slot)
    } else if (
      report.rootPresent &&
      (report.surface === 'app' || report.surface === 'route-error')
    ) {
      if (slot.phase !== 'ready' && slot.phase !== 'suspect') return
      const changed = slot.phase !== 'ready'
      this.markReady(slot)
      if (changed) this.deps.capabilitiesChanged?.(id)
    } else if (report.surface === 'fatal-fallback') {
      this.block(slot, 'render-failed', false)
    } else if (slot.phase !== 'booting') {
      this.suspect(slot)
      slot.misses++
    }
  }

  failure(sender: WebContents, failure: RendererFailure): void {
    const id = this.validate(sender, failure.generation)
    const slot = this.slots.get(id)
    if (!slot) return
    if (failure.scope === 'root' || failure.scope === 'bootstrap') {
      this.block(slot, failure.errorCode, false)
    }
    // Async/route errors are handled by their local surfaces. Never turn a
    // business rejection or a bad route into an automatic document restart.
  }

  hasCapability(id: WindowId, capability: RendererCapability): boolean {
    const slot = this.slots.get(id)
    return Boolean(
      slot &&
        this.current(slot) &&
        slot.phase === 'ready' &&
        slot.capabilities.has(capability)
    )
  }

  recoverManually(id: WindowId): boolean {
    const slot = this.slots.get(id)
    if (
      !slot ||
      !this.current(slot) ||
      this.stopped ||
      this.suspended ||
      this.locked ||
      this.modalDepth > 0 ||
      slot.phase === 'recovering' ||
      !this.budget.reserveManual(id)
    )
      return false
    slot.manual = true
    slot.recovered = true
    slot.route = id === 'main' ? '/downloads/all' : undefined
    slot.requestedShow = true
    slot.phase = 'recovering'
    slot.recoveryDue = undefined
    this.clearProbe(slot)
    this.emit(slot, 'manual-recovery')
    try {
      this.deps.recreate(id, true)
    } catch {
      this.block(slot, 'recovery-failed')
    }
    return true
  }

  setSuspended(value: boolean): void {
    this.suspended = value
    this.grantGrace(timing.wakeGrace)
  }

  setLocked(value: boolean): void {
    this.locked = value
    this.grantGrace(timing.wakeGrace)
  }

  enterModal(): () => void {
    this.modalDepth++
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.modalDepth--
      this.grantGrace(timing.modalGrace)
    }
  }

  gpuExited(): void {
    for (const slot of this.slots.values()) {
      if (this.eligible(slot)) this.probe(slot)
    }
  }

  tick(): void {
    const now = this.now()
    const lag = now - this.lastTick - 1_000
    this.lastTick = now
    if (this.stopped) return
    if (lag > timing.schedulerLag) this.grantGrace(timing.wakeGrace)
    if (this.inhibited()) {
      for (const slot of this.slots.values()) {
        slot.bootDeadline = now + timing.boot
        slot.stableSince = undefined
        this.clearProbe(slot)
      }
      return
    }
    for (const slot of this.slots.values()) {
      if (!this.current(slot)) continue
      if (slot.recoveryDue !== undefined && now >= slot.recoveryDue) {
        if (!this.foreground(slot)) {
          slot.recoveryDue = undefined
          slot.phase = 'deferred'
          continue
        }
        slot.recoveryDue = undefined
        try {
          if (slot.attempt > 1) this.deps.recreate(slot.id)
          else this.deps.reload(slot.id)
        } catch {
          this.block(slot, 'recovery-failed')
        }
        continue
      }
      if (!this.foreground(slot)) {
        slot.bootDeadline = now + timing.boot
        slot.stableSince = undefined
        this.clearProbe(slot)
        continue
      }
      if (slot.phase === 'booting' && now >= slot.bootDeadline) {
        this.block(slot, 'boot-timeout')
      }
      if (slot.phase === 'blocked' && slot.nativeFallback) this.prompt(slot)
      if (!this.eligible(slot)) continue
      if (slot.probe && now >= slot.probe.deadline) {
        slot.probe = undefined
        this.suspect(slot)
        slot.misses++
      }
      if (
        slot.phase === 'suspect' &&
        slot.misses >= 3 &&
        now - (slot.suspectSince ?? now) >= timing.suspect
      ) {
        if (!slot.hangReported) {
          slot.hangReported = true
          this.emit(slot, 'unresponsive')
        }
        this.prompt(slot)
      }
      if (
        (slot.phase === 'ready' || slot.phase === 'suspect') &&
        now >= slot.nextProbe
      )
        this.probe(slot)
      if (
        slot.phase === 'ready' &&
        slot.stableSince !== undefined &&
        now - slot.stableSince >= timing.stable
      ) {
        if (slot.recovered) this.emit(slot, 'recovered')
        slot.recovered = false
        slot.manual = false
        slot.stableSince = undefined
        this.memoryPressure = false
      }
    }
  }

  dispose(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const id of this.slots.keys()) this.released(id, 'shutdown')
  }

  private senderSlot(sender: WebContents): Slot {
    for (const slot of this.slots.values()) {
      if (this.current(slot) && slot.win?.webContents === sender) return slot
    }
    throw new Error('Unknown renderer session')
  }

  private current(slot: Slot): boolean {
    return (
      !this.stopped &&
      this.slots.get(slot.id) === slot &&
      Boolean(slot.win && !slot.win.isDestroyed())
    )
  }

  private visible(slot: Slot): boolean {
    return Boolean(slot.win?.isVisible() && !slot.win.isMinimized())
  }

  private foreground(slot: Slot): boolean {
    return (
      this.visible(slot) || (slot.requestedShow && !slot.win?.isMinimized())
    )
  }

  private eligible(slot: Slot): boolean {
    return (
      this.current(slot) &&
      this.visible(slot) &&
      slot.documentVisible &&
      !this.inhibited() &&
      !slot.win?.webContents.isDevToolsOpened()
    )
  }

  private inhibited(): boolean {
    return (
      this.stopped ||
      this.suspended ||
      this.locked ||
      this.modalDepth > 0 ||
      this.now() < this.graceUntil
    )
  }

  private grantGrace(duration: number): void {
    const now = this.now()
    this.graceUntil = now + duration
    for (const slot of this.slots.values()) {
      this.clearProbe(slot)
      slot.stableSince = undefined
      slot.bootDeadline = now + duration + timing.boot
      slot.nextProbe = now + duration
    }
  }

  private beginDocument(slot: Slot): void {
    slot.generation = randomUUID()
    slot.phase = 'booting'
    slot.surface = 'boot'
    slot.capabilities.clear()
    slot.documentVisible = true
    slot.promptShown = false
    slot.hangReported = false
    slot.nativeFallback = false
    slot.stableSince = undefined
    slot.recoveryDue = undefined
    slot.bootDeadline = this.now() + timing.boot
    this.clearProbe(slot)
    this.deps.capabilitiesChanged?.(slot.id)
  }

  private exited(slot: Slot, reason: string): void {
    if (
      slot.phase === 'recovering' ||
      slot.phase === 'deferred' ||
      (slot.phase === 'blocked' && slot.nativeFallback)
    )
      return
    slot.incidentId = randomUUID()
    slot.reason = reason
    slot.surface = 'missing'
    slot.capabilities.clear()
    slot.promptShown = false
    this.clearProbe(slot)
    this.deps.capabilitiesChanged?.(slot.id)
    const classification = classifyRendererExit(reason)
    if (classification === 'memory') this.memoryPressure = true
    // A root failure remains manual even if its fallback renderer then exits.
    // Its DOM controls are gone, so native feedback must take over.
    if (slot.phase === 'blocked' || classification === 'block' || slot.manual) {
      this.block(slot, reason)
    } else if (!this.foreground(slot)) {
      slot.phase = 'deferred'
      this.emit(slot, reason)
    } else this.scheduleRecovery(slot)
  }

  private scheduleRecovery(slot: Slot): void {
    if (this.deps.mode === 'observe' || this.inhibited()) {
      this.block(slot, slot.reason || 'renderer-exited')
      return
    }
    const reservation = this.budget.reserveAutomatic(
      [slot.id],
      classifyRendererExit(slot.reason) === 'memory'
    )
    if (!reservation) {
      this.block(slot, 'retry-limit')
      return
    }
    slot.phase = 'recovering'
    slot.attempt = reservation.attempt
    slot.recovered = true
    slot.recoveryDue = this.now() + reservation.delay
    this.emit(slot, 'recovery-scheduled')
  }

  private probe(slot: Slot): void {
    if (
      !this.eligible(slot) ||
      slot.probe ||
      (slot.phase !== 'ready' && slot.phase !== 'suspect')
    )
      return
    const now = this.now()
    const id = randomUUID()
    slot.probe = { id, deadline: now + timing.probeDeadline }
    slot.nextProbe = now + timing.probeInterval
    try {
      slot.win?.webContents.send(Events.RendererHealthProbe, {
        generation: slot.generation,
        challengeId: id,
      })
    } catch {
      slot.probe = undefined
      this.suspect(slot)
    }
  }

  private suspect(slot: Slot): void {
    if (slot.phase !== 'ready' && slot.phase !== 'suspect') return
    if (slot.phase === 'ready') {
      slot.incidentId = randomUUID()
      slot.reason = 'unresponsive'
      slot.promptShown = false
      slot.hangReported = false
    }
    slot.phase = 'suspect'
    slot.suspectSince ??= this.now()
    slot.stableSince = undefined
  }

  private markReady(slot: Slot): void {
    if (slot.phase === 'suspect') {
      // Waiting may let the same document recover. Retire that incident so a
      // late dialog response cannot act on a subsequent failure.
      slot.incidentId = randomUUID()
      slot.reason = ''
      slot.promptShown = false
      slot.hangReported = false
    }
    slot.phase = 'ready'
    if (this.eligible(slot)) slot.stableSince ??= this.now()
    else slot.stableSince = undefined
    this.clearProbe(slot)
    slot.nextProbe = this.now() + timing.probeInterval
  }

  private clearProbe(slot: Slot): void {
    slot.probe = undefined
    slot.misses = 0
    slot.suspectSince = undefined
  }

  private block(slot: Slot, reason: string, native = true): void {
    if (!this.current(slot)) return
    const changed = slot.phase !== 'blocked' || slot.nativeFallback !== native
    slot.phase = 'blocked'
    slot.nativeFallback = native
    slot.reason = reason
    slot.recoveryDue = undefined
    slot.capabilities.clear()
    this.clearProbe(slot)
    if (changed) this.emit(slot, reason)
    if (native) this.prompt(slot)
    this.deps.capabilitiesChanged?.(slot.id)
  }

  private prompt(slot: Slot): void {
    if (slot.promptShown || this.inhibited() || !this.foreground(slot)) return
    slot.promptShown = true
    this.deps.prompt(this.incident(slot))
  }

  isCurrentIncident(incident: RendererIncident): boolean {
    const slot = this.slots.get(incident.windowId)
    return Boolean(
      slot &&
        this.current(slot) &&
        slot.incidentId === incident.incidentId &&
        slot.generation === incident.generation &&
        (slot.phase === 'blocked' || slot.phase === 'suspect')
    )
  }

  private incident(slot: Slot): RendererIncident {
    return {
      generation: slot.generation,
      incidentId: slot.incidentId,
      windowId: slot.id,
      phase: slot.phase,
      reason: slot.reason,
      attempt: slot.attempt,
    }
  }

  private emit(slot: Slot, reason: string): void {
    this.deps.report({ ...this.incident(slot), reason })
  }
}
