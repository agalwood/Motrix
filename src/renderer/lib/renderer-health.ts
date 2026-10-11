import { rendererRecovery as en } from '@shared/locales/en-US.json'
import { rendererRecovery as zh } from '@shared/locales/zh-CN.json'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type RendererCapability,
  type RendererSession,
  type RendererSurface,
  rendererProbeSchema,
  rendererSessionSchema,
} from '@shared/schemas/renderer-health'
import { rendererIntentSchema } from '@shared/schemas/renderer-intent'
import { applyRendererIntent } from './renderer-intents'
import { ElectronTransport } from './transport/electron'

// Kept outside the React/provider graph so failures there cannot remove recovery.
const wire = new ElectronTransport()
const capabilities = new Map<RendererCapability, number>()
let session: RendererSession | undefined
let surface: RendererSurface = 'boot'
let missingSince: number | undefined
let fallback: HTMLElement | undefined
let bootTimer: ReturnType<typeof setTimeout> | undefined
const bootLocale = new URLSearchParams(location.search).get('locale')
const strings = () =>
  session?.strings ?? (bootLocale?.startsWith('zh') ? zh : en)
export const rendererSession = () => session

function observedSurface(): RendererSurface {
  if (fallback?.isConnected) return 'fatal-fallback'
  const present = Boolean(document.getElementById('root')?.firstElementChild)
  if (present || surface === 'boot') {
    missingSince = undefined
    return surface
  }
  missingSince ??= performance.now()
  return performance.now() - missingSince >= 2_000 ? 'missing' : surface
}
function report(): void {
  if (!session) return
  void wire
    .invoke(Commands.ReportRendererSurface, {
      generation: session.generation,
      surface: observedSurface(),
      capabilities: [...capabilities.keys()],
      documentVisible: !document.hidden,
      route: location.hash.slice(1),
    })
    .catch(() => {})
}
export function registerRendererCapability(
  capability: RendererCapability
): () => void {
  capabilities.set(capability, (capabilities.get(capability) ?? 0) + 1)
  report()
  return () => {
    const count = (capabilities.get(capability) ?? 1) - 1
    if (count) capabilities.set(capability, count)
    else capabilities.delete(capability)
    report()
  }
}
export function setRendererSurface(value: RendererSurface): void {
  surface = value
  if (value === 'app' || value === 'route-error') {
    clearTimeout(bootTimer)
    document.getElementById('renderer-boot')?.remove()
  }
  report()
}

export async function startRendererHealth(): Promise<void> {
  bootTimer = setTimeout(() => showRendererFailure('bootstrap'), 30_000)
  if (__MOTRIX_TARGET__ === 'web') return
  wire.on(Events.RendererHealthProbe, (...args) => {
    const probe = rendererProbeSchema.safeParse(args[0])
    if (!probe.success || probe.data.generation !== session?.generation) return
    const current = observedSurface()
    void wire
      .invoke(Commands.AcknowledgeRendererProbe, {
        ...probe.data,
        surface: current,
        rootPresent:
          current !== 'missing' &&
          (Boolean(document.getElementById('root')?.firstElementChild) ||
            Boolean(fallback?.isConnected)),
        documentVisible: !document.hidden,
      })
      .catch(() => {})
  })
  wire.on(Events.RendererIntent, (...args) => {
    const parsed = rendererIntentSchema.safeParse(args[0])
    if (!parsed.success || parsed.data.generation !== session?.generation)
      return
    const intent = parsed.data
    void applyRendererIntent(intent.channel, intent.payload)
      .then((applied) => {
        if (applied)
          return wire.invoke(Commands.AcknowledgeRendererIntent, {
            generation: intent.generation,
            id: intent.id,
          })
      })
      .catch(() => {})
  })
  let sessionDeadline: ReturnType<typeof setTimeout> | undefined
  const raw = await Promise.race([
    wire.invoke(Queries.GetRendererSession),
    new Promise((_, reject) => {
      sessionDeadline = setTimeout(
        () => reject(new Error('Renderer session timed out')),
        5_000
      )
    }),
  ]).finally(() => clearTimeout(sessionDeadline))
  session = rendererSessionSchema.parse(raw)
  // A normal reload already carries the current route in its URL. Only a
  // fresh window/load without a fragment needs the main-owned restore route.
  if (session.route && session.windowId === 'main' && !location.hash)
    location.hash = session.route
  document.addEventListener('visibilitychange', report)
  window.addEventListener('hashchange', report)
  report()
}

export function showRendererFailure(scope: 'bootstrap' | 'root'): void {
  if (fallback) return
  clearTimeout(bootTimer)
  document.getElementById('renderer-boot')?.remove()
  surface = 'fatal-fallback'
  const copy = strings()
  const panel = document.createElement('section')
  panel.id = 'renderer-recovery'
  panel.setAttribute('role', 'alert')
  panel.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;gap:16px;padding:32px;background:Canvas;color:CanvasText;font:14px system-ui;-webkit-app-region:no-drag;color-scheme:light dark'
  const title = document.createElement('h1')
  title.textContent = copy.title
  title.style.fontSize = '20px'
  const description = document.createElement('p')
  description.textContent = copy.description
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap'
  const recover = document.createElement('button')
  recover.textContent = copy.recover
  recover.onclick = () => {
    if (__MOTRIX_TARGET__ === 'web') {
      location.reload()
      return
    }
    recover.disabled = true
    description.textContent = copy.recovering
    void wire
      .invoke(Commands.RecoverCurrentRenderer, {
        generation: session?.generation,
      })
      .then((ok) => {
        if (!ok) {
          recover.disabled = false
          description.textContent = copy.failed
        }
      })
      .catch(() => {
        recover.disabled = false
        description.textContent = copy.failed
      })
  }
  actions.append(recover)
  if (__MOTRIX_TARGET__ !== 'web') {
    const diagnostics = document.createElement('button')
    diagnostics.textContent = copy.diagnostics
    diagnostics.onclick = () => {
      void wire
        .invoke(Commands.OpenRendererDiagnostics, {
          generation: session?.generation,
        })
        .catch(() => {
          description.textContent = copy.failed
        })
    }
    actions.append(diagnostics)
  }
  panel.append(title, description, actions)
  document.body.append(panel)
  fallback = panel
  recover.focus()
  report()
  if (session)
    void wire
      .invoke(Commands.ReportRendererFailure, {
        generation: session.generation,
        scope,
        errorCode: 'render-failed',
      })
      .catch(() => {})
}
