import {
  type MotrixIcon,
  SpeedAutoIcon,
  SpeedLimitedIcon,
  SpeedUnlimitedIcon,
} from '@renderer/components/icons'
import type { TurtleState } from '@shared/types/settings'

/** Shared mode order and glyphs for the dashboard and Downloads controls. */
export const SPEED_LIMIT_MODES = [
  { id: 'off', Icon: SpeedUnlimitedIcon },
  { id: 'on', Icon: SpeedLimitedIcon },
  { id: 'auto', Icon: SpeedAutoIcon },
] as const satisfies ReadonlyArray<{ id: TurtleState; Icon: MotrixIcon }>
