import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { X } from 'lucide-react'
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { DownloadsFields } from './downloads-form'

const EXTENSION_PATTERN = /^\.[a-z0-9]+$/i
const MAX_EXTENSIONS = 100

/**
 * AutoParser link-filter settings table, plus the "skip existing files"
 * toggle. Lives in the Downloads card because the whitelist governs which
 * files the add-task AutoParser tab surfaces — only links whose extension
 * matches the whitelist are listed.
 */
export function AutoparserSection({
  form,
}: {
  form: UseFormReturn<DownloadsFields>
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')

  const addDraft = (
    list: string[],
    onChange: (value: string[]) => void,
    raw: string
  ) => {
    const ext = raw.trim().toLowerCase()
    if (!ext.startsWith('.')) return
    if (!EXTENSION_PATTERN.test(ext)) return
    if (list.length >= MAX_EXTENSIONS) return
    if (list.includes(ext)) {
      setDraft('')
      return
    }
    onChange([...list, ext])
    setDraft('')
  }

  return (
    <section className="space-y-4">
      <FormField
        name="app.skipExistingFilesOnCreate"
        render={({ field }) => (
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t('settings.downloads.autoparser.skipExistingLabel')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.downloads.autoparser.skipExistingDescription')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        name="app.autoparser.fileExtensionWhitelist"
        render={({ field }) => {
          const list = field.value ?? []
          return (
            <FormItem>
              <FormLabel>
                {t('settings.downloads.autoparser.whitelistLabel')}
              </FormLabel>
              <FormControl>
                <div className="space-y-2">
                  {list.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('settings.downloads.autoparser.whitelistEmpty')}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((ext: string) => (
                      <Badge key={ext} variant="secondary">
                        {ext}
                        <button
                          type="button"
                          className="ms-1 rounded-sm opacity-60 hover:opacity-100"
                          aria-label={t('common.remove')}
                          onClick={() => {
                            field.onChange(
                              list.filter((item: string) => item !== ext)
                            )
                          }}
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      className="h-8 w-40 font-mono text-xs"
                      value={draft}
                      placeholder={t(
                        'settings.downloads.autoparser.whitelistPlaceholder'
                      )}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addDraft(list, field.onChange, draft)
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => addDraft(list, field.onChange, draft)}
                    >
                      {t('common.add')}
                    </Button>
                  </div>
                </div>
              </FormControl>
              <FormDescription>
                {t('settings.downloads.autoparser.whitelistDescription')}
              </FormDescription>
            </FormItem>
          )
        }}
      />
    </section>
  )
}