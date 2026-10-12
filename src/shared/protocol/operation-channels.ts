import { Commands } from './commands'
export const OPERATION_CHANNELS: ReadonlySet<string> = new Set([
  Commands.UpdatePluginOperationDraft,
  Commands.RevealPluginOperation,
  Commands.GetPluginOperations,
  Commands.PreparePluginOperation,
  Commands.PickPluginOperationFile,
  Commands.GetPluginOperationPicker,
  Commands.DiscardPluginOperation,
  Commands.StartPluginOperation,
  Commands.GetPluginOperationJob,
  Commands.CancelPluginOperation,
])
