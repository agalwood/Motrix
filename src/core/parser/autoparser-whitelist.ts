import type { SettingsManager } from '@core/settings/settings-manager'

/**
 * Resolve the AutoParser extension whitelist from live user settings.
 * Returns an empty set when no whitelist is configured — an empty whitelist
 * yields no links (pure whitelist filtering). Read per parse so settings
 * changes — including hot-reloaded settings.json edits — apply immediately.
 */
export function resolveAutoparserExtensionWhitelist(
  settingsManager: SettingsManager
): ReadonlySet<string> {
  return new Set(
    settingsManager.getApp().autoparser.fileExtensionWhitelist.map((ext) =>
      ext.toLowerCase()
    )
  )
}