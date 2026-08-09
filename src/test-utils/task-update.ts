// Synchronous pass-through for the TaskUpdatePublisher deps pair.
//
// Action-level tests assert "this action broadcast a TaskUpdated snapshot"
// via `expect(eventBus.emit).toHaveBeenCalledWith(Events.TaskUpdated, ...)`.
// Production routes that broadcast through TaskUpdatePublisher (trailing,
// 16 ms window), which would make those assertions async for no gain — the
// publisher's own timing semantics are covered by task-update-publisher.test
// and the routing tests in actions/shared.test. This helper keeps the
// existing synchronous assertions valid: both publish verbs emit the full
// snapshot inline, exactly like the pre-coalescing direct emit.

import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'

export interface DirectTaskUpdatePublicationDeps {
  eventBus: { emit(channel: string, ...args: unknown[]): void }
  taskManager: { getAll(): DownloadTask[] }
}

export function directTaskUpdatePublication(
  deps: DirectTaskUpdatePublicationDeps
): { publishTaskUpdate: () => void; publishTaskUpdateNow: () => void } {
  const emit = () =>
    deps.eventBus.emit(Events.TaskUpdated, deps.taskManager.getAll())
  return { publishTaskUpdate: emit, publishTaskUpdateNow: emit }
}
