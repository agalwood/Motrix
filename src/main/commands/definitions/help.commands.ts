import { CommandIds } from '@shared/commands-catalog'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { shell } from 'electron'
import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'

export function registerHelpCommands(
  registry: CommandRegistry,
  _deps: CommandDeps
): void {
  registry.register({
    id: CommandIds.HelpOpenWebsite,
    title: 'menu.help.officialWebsite',
    run: () => {
      shell.openExternal(EXTERNAL_URLS.motrix.home)
    },
  })
  registry.register({
    id: CommandIds.HelpOpenManual,
    title: 'menu.help.manual',
    run: () => {
      shell.openExternal(EXTERNAL_URLS.motrix.manual.home)
    },
  })
  registry.register({
    id: CommandIds.HelpOpenChangelog,
    title: 'menu.help.changelog',
    run: () => {
      shell.openExternal(EXTERNAL_URLS.motrix.changelog)
    },
  })
  registry.register({
    id: CommandIds.HelpReportProblem,
    title: 'menu.help.reportProblem',
    run: () => {
      shell.openExternal(EXTERNAL_URLS.github.issues)
    },
  })
}
