import { AddIcon, RemoveIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import type { AutoCategorizeRule } from '@shared/schemas/auto-categorize'
import {
  AUTO_CATEGORIZE_RULE_LIMIT,
  autoCategorizeExtensionSchema,
  isPlainFolderSegment,
} from '@shared/schemas/auto-categorize'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { DownloadsFields } from './downloads-form'

// IDM-style extension → subfolder routing (#1131). The whole
// app.autoCategorize object is a single form field; rows are plain
// controlled inputs living inside field.value so a dirty check and the
// zod resolver see one atomic value.
export function AutoCategorizeSection({
  form,
  disabled,
}: {
  form: UseFormReturn<DownloadsFields>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <FormField
      control={form.control}
      name="app.autoCategorize"
      render={({ field }) => {
        const settings = field.value
        const update = (rules: AutoCategorizeRule[]) =>
          field.onChange({ ...settings, rules })
        const setRule = (index: number, rule: AutoCategorizeRule) =>
          update(settings.rules.map((r, i) => (i === index ? rule : r)))
        const removeRule = (index: number) =>
          update(settings.rules.filter((_, i) => i !== index))
        return (
          <FormItem className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>
                  {t('settings.downloads.autoCategorize.enable')}
                </FormLabel>
                <FormDescription className="text-xs">
                  {t('settings.downloads.autoCategorize.enableDesc')}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={settings.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    field.onChange({ ...settings, enabled })
                  }
                />
              </FormControl>
            </div>
            {settings.enabled && (
              <div className="space-y-2">
                {settings.rules.map((rule, index) => (
                  <RuleRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: rules support append/remove only and rows are fully controlled, so an index remount has no visible effect.
                    key={index}
                    rule={rule}
                    disabled={disabled}
                    onChange={(next) => setRule(index, next)}
                    onRemove={() => removeRule(index)}
                  />
                ))}
                <div className="flex items-center justify-between gap-4">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      disabled ||
                      settings.rules.length >= AUTO_CATEGORIZE_RULE_LIMIT
                    }
                    onClick={() =>
                      update([...settings.rules, { exts: [], folder: '' }])
                    }
                  >
                    <AddIcon />
                    {t('settings.downloads.autoCategorize.addRule')}
                  </Button>
                </div>
              </div>
            )}
            <FormMessage className="text-xs" />
          </FormItem>
        )
      }}
    />
  )
}

function RuleRow({
  rule,
  disabled,
  onChange,
  onRemove,
}: {
  rule: AutoCategorizeRule
  disabled?: boolean
  onChange: (rule: AutoCategorizeRule) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const extsText = rule.exts.join(', ')
  const extsError =
    rule.exts.length === 0
      ? t('settings.downloads.autoCategorize.needsExtension')
      : null
  const folderError = isPlainFolderSegment(rule.folder)
    ? null
    : t('settings.downloads.autoCategorize.invalidFolder')
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          value={extsText}
          disabled={disabled}
          placeholder={t(
            'settings.downloads.autoCategorize.extensionsPlaceholder'
          )}
          aria-label={t('settings.downloads.autoCategorize.extensions')}
          onChange={(event) => {
            const exts = parseExtensions(event.target.value)
            onChange({ ...rule, exts })
          }}
        />
        {extsError && <p className="text-xs text-destructive">{extsError}</p>}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          value={rule.folder}
          disabled={disabled}
          placeholder={t('settings.downloads.autoCategorize.folderPlaceholder')}
          aria-label={t('settings.downloads.autoCategorize.folder')}
          onChange={(event) =>
            onChange({ ...rule, folder: event.target.value })
          }
        />
        {folderError && (
          <p className="text-xs text-destructive">{folderError}</p>
        )}
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled}
        aria-label={t('settings.downloads.autoCategorize.removeRule')}
        onClick={onRemove}
      >
        <RemoveIcon />
      </Button>
    </div>
  )
}

// Accepts "mp4, .mkv;WEBM" — separators are commas, semicolons, or
// whitespace; leading dots are optional and everything is lowercased.
// Invalid fragments are dropped rather than blocking the whole list.
function parseExtensions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,;\s]+/)
        .map((part) => part.replace(/^\./, '').toLowerCase())
        .filter((part) => autoCategorizeExtensionSchema.safeParse(part).success)
    ),
  ]
}
