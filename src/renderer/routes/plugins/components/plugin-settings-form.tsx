import { zodResolver } from '@hookform/resolvers/zod'
import { PluginConfigField } from '@renderer/components/settings-kit/plugin-config-field'
import { Button } from '@renderer/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import {
  defaultFromSchema,
  jsonSchemaToZod,
} from '@renderer/lib/json-schema-to-zod'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { JsonSchemaNode } from '@shared/types/plugin'
import { useMemo } from 'react'
import { type FieldValues, type Resolver, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

type SettingsValues = Record<string, unknown> & FieldValues

export function PluginSettingsForm({
  pluginId,
  schema,
  initialValues,
}: {
  pluginId: string
  schema: JsonSchemaNode
  initialValues: Record<string, unknown>
}) {
  const { t } = useTranslation()
  const zod = useMemo(() => jsonSchemaToZod(schema), [schema])
  const defaults = useMemo<SettingsValues>(
    () => ({ ...defaultFromSchema(schema), ...initialValues }),
    [schema, initialValues]
  )

  // Zod schema is derived from a bounded JSON Schema subset; the resolver
  // returns the parsed payload as `unknown`. We narrow to SettingsValues here.
  const resolver = useMemo<Resolver<SettingsValues>>(
    () =>
      (zodResolver as unknown as (s: unknown) => Resolver<SettingsValues>)(zod),
    [zod]
  )
  const form = useForm<SettingsValues>({
    defaultValues: defaults,
    resolver,
  })
  const properties = schema.properties ?? {}

  const onSubmit = async (values: SettingsValues) => {
    const dirty: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) {
      if (form.formState.dirtyFields[k]) dirty[k] = v
    }
    if (Object.keys(dirty).length === 0) return
    await transport.invoke(Commands.UpdatePluginConfig, {
      pluginId,
      patch: dirty,
    })
    form.reset(values)
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="rounded-lg border bg-card shadow-none"
      >
        <div className="divide-y">
          {Object.entries(properties).map(([fieldName, node]) => (
            <FormField
              key={fieldName}
              control={form.control}
              name={fieldName}
              render={() => (
                <FormItem className="grid gap-3 px-4 py-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-center">
                  <div className="min-w-0 space-y-1">
                    {/* Field labels/descriptions are localized by the plugin
                        manifest's %placeholder% mechanism (resolveManifestI18n),
                        not the app i18next bundle — a plugin id like
                        "motrix.scraper-hook" can never resolve as an i18next key.
                        Fall back to the raw field name when a plugin omits a
                        title, never an unresolved key. */}
                    <FormLabel className="text-sm font-medium">
                      {node.title ?? fieldName}
                    </FormLabel>
                    {node.description && (
                      <FormDescription className="text-xs leading-5">
                        {node.description}
                      </FormDescription>
                    )}
                  </div>
                  <FormControl>
                    <div className="flex min-w-0 sm:justify-end">
                      <PluginConfigField name={fieldName} node={node} />
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => form.reset(defaults)}
          >
            {t('common.reset')}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!form.formState.isDirty || form.formState.isSubmitting}
          >
            {t('common.apply')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
