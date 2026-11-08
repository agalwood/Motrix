import { Commands } from '@shared/protocol/commands'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import type { OperationPrincipal, OperationService } from './operation-service'
export function operationHandlers(
  service: OperationService
): CommandHandlerMap {
  return {
    [Commands.UpdatePluginOperationDraft]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.update(owner, value),
    [Commands.RevealPluginOperation]: async () => {
      throw new Error('pluginOperations.unsupported')
    },
    [Commands.GetPluginOperations]: async (owner: OperationPrincipal) =>
      service.state(owner),
    [Commands.PreparePluginOperation]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.prepare(owner, value),
    [Commands.PickPluginOperationFile]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.pick(owner, value),
    [Commands.GetPluginOperationPicker]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.picker(owner, value),
    [Commands.DiscardPluginOperation]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.discard(owner, value),
    [Commands.StartPluginOperation]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.start(owner, value),
    [Commands.GetPluginOperationJob]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.get(owner, value),
    [Commands.CancelPluginOperation]: async (
      owner: OperationPrincipal,
      value: unknown
    ) => service.cancel(owner, value),
  }
}
