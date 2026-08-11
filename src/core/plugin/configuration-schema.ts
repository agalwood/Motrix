import type { PluginManifest } from '@shared/types/plugin'

export function pluginSecretFields(
  manifest: Pick<PluginManifest, 'contributes'> | undefined
): ReadonlySet<string> {
  const schema = manifest?.contributes.configuration?.schema
  const properties =
    schema &&
    typeof schema === 'object' &&
    'properties' in schema &&
    schema.properties &&
    typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  const secretFields = new Set<string>()
  for (const [key, property] of Object.entries(properties)) {
    if (
      property &&
      typeof property === 'object' &&
      (property as { secret?: boolean }).secret === true
    ) {
      secretFields.add(key)
    }
  }
  return secretFields
}
