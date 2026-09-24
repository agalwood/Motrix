import type { TurtleState } from '@shared/types/settings'
import { type LucideIcon, Rabbit, Squirrel, Turtle } from 'lucide-react'

/** Shared mode order and glyphs for the dashboard and Downloads controls. */
export const SPEED_LIMIT_MODES = [
  { id: 'off', Icon: Rabbit },
  { id: 'on', Icon: Turtle },
  { id: 'auto', Icon: Squirrel },
] as const satisfies ReadonlyArray<{ id: TurtleState; Icon: LucideIcon }>
