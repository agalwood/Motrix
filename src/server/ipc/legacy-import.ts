import { AppError, ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import type {
  CommandHandlerMap,
  QueryHandlerMap,
} from '@shared/protocol/handler-types'
import { Queries } from '@shared/protocol/queries'

async function desktopOnly(): Promise<never> {
  throw new AppError(
    ErrorCode.EngineNotSupported,
    'legacyImport.errors.desktopOnly'
  )
}

/** Server requests cannot select, read or write a local legacy profile. */
export function unsupportedLegacyImportCommands(): CommandHandlerMap {
  return {
    [Commands.ActivateLegacyBt]: desktopOnly,
    [Commands.PickLegacyImportSource]: desktopOnly,
    [Commands.PickLegacyTorrentMetadata]: desktopOnly,
    [Commands.CommitLegacyImport]: desktopOnly,
    [Commands.CancelLegacyImport]: desktopOnly,
    [Commands.RetryLegacyImport]: desktopOnly,
    [Commands.DismissLegacyImportInvitation]: desktopOnly,
    [Commands.FinishLegacyImportInvitation]: desktopOnly,
    [Commands.PrepareLegacyFreshDownload]: desktopOnly,
    [Commands.ExportLegacyImportReport]: desktopOnly,
  }
}

export function unsupportedLegacyImportQueries(): QueryHandlerMap {
  return {
    [Queries.GetLegacyImportNavigation]: async () => ({
      detected: false,
      invitationPending: false,
    }),
    [Queries.GetLegacyBtActivationAvailability]: desktopOnly,
    [Queries.DiscoverLegacyImport]: desktopOnly,
    [Queries.ScanLegacyImport]: desktopOnly,
    [Queries.GetLegacyImportRun]: desktopOnly,
  }
}
