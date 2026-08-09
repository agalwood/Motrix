import type { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { powerSaveBlocker } from 'electron'

export function setupPowerManager(eventBus: EventBus): void {
  let blockId: number | null = null

  eventBus.on(Events.EngineActiveChanged, (active) => {
    if (active && blockId === null) {
      blockId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!active && blockId !== null) {
      powerSaveBlocker.stop(blockId)
      blockId = null
    }
  })
}
