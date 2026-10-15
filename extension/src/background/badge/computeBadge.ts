import type { ConnectionState } from '@/background/ConnectionManager'

export type IconVariant = 'color' | 'grey'
export interface BadgeVisual {
  text: string
  bg: string
  fg: string
}
export interface BadgeVisualState {
  icon: IconVariant
  badge: BadgeVisual | null
  tooltipKey: string
}
export interface BadgeInput {
  connection: ConnectionState
  hasActivity: boolean
  hasUnackError: boolean
}

const RED = '#e03131'
const AMBER = '#f0a020'
const GREEN = '#12b886'
const WHITE = '#ffffff'

// Every badge uses white text; only the glyph and background vary per state.
const mk = (text: string, bg: string): BadgeVisual => ({ text, bg, fg: WHITE })

export function computeBadge(i: BadgeInput): BadgeVisualState {
  const icon: IconVariant = i.connection === 'connected' ? 'color' : 'grey'

  if (i.hasUnackError)
    return { icon, badge: mk('!', RED), tooltipKey: 'badge.tooltip.error' }
  if (i.connection === 'denied')
    return { icon, badge: mk('!', AMBER), tooltipKey: 'badge.tooltip.denied' }
  if (
    i.connection === 'bootstrapping' ||
    i.connection === 'connecting' ||
    i.connection === 'handshaking' ||
    i.connection === 'awaiting-code'
  )
    return {
      icon,
      // Browser action badges have a platform-defined minimum size. A single
      // bullet therefore renders as an oversized amber tile over a 16 px icon.
      // Keep the transient state in the grey icon + tooltip instead; the popup
      // provides the detailed connection progress while it is open.
      badge: null,
      tooltipKey: 'badge.tooltip.connecting',
    }
  if (i.connection === 'connected' && i.hasActivity)
    return {
      icon,
      badge: mk('↓', GREEN),
      tooltipKey: 'badge.tooltip.downloading',
    }
  return {
    icon,
    badge: null,
    tooltipKey:
      i.connection === 'connected'
        ? 'badge.tooltip.connected'
        : 'badge.tooltip.disconnected',
  }
}
