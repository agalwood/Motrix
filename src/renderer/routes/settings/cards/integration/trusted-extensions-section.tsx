import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { browserDisplayName } from '@renderer/lib/browser-name'
import { cn } from '@renderer/lib/utils'
import type { TrustedExtensionInfo } from '@shared/protocol/bridge'
import { ChevronRight, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTrustedExtensions } from './use-bridge'

const SOURCE_ORDER: Record<TrustedExtensionInfo['source'], number> = {
  builtin: 0,
  'user-added': 1,
  imported: 2,
}

type Browser = 'chromium' | 'firefox'

function cleanIpcErrorMessage(raw: string): string {
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
    .trim()
}

function chromeIdHint() {
  return 'e.g. cfhdojbkjhnklbpkdaibdccddilifddb'
}

function firefoxIdHint() {
  return 'e.g. addon-name@example.com'
}

export function TrustedExtensionsSection({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation()
  const { items, add, remove } = useTrustedExtensions()
  const [open, setOpen] = useState(false)
  const [newId, setNewId] = useState('')
  const [newBrowser, setNewBrowser] = useState<Browser>('chromium')
  const [newLabel, setNewLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const browserOptions = [
    {
      value: 'chromium',
      label: t('settings.integration.browser.addTrusted.chromiumEdge'),
    },
    {
      value: 'firefox',
      label: t('settings.integration.browser.addTrusted.firefox'),
    },
  ] satisfies ReadonlyArray<{ value: Browser; label: string }>

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        const order = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
        return order !== 0 ? order : a.id.localeCompare(b.id)
      }),
    [items]
  )

  const handleAdd = async () => {
    if (!newId.trim()) return
    setError(null)
    setSubmitting(true)
    try {
      await add(newId.trim(), newBrowser, newLabel.trim() || undefined)
      setNewId('')
      setNewLabel('')
    } catch (e) {
      setError(cleanIpcErrorMessage((e as Error).message))
    } finally {
      setSubmitting(false)
    }
  }

  const idPlaceholder =
    newBrowser === 'chromium' ? chromeIdHint() : firefoxIdHint()

  return (
    <div
      className={cn('space-y-2', disabled && 'pointer-events-none opacity-50')}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 flex h-7 w-full items-center justify-between pl-2 pr-0 text-xs text-muted-foreground hover:text-foregroun hover:bg-transparent dark:hover:bg-transparent"
            />
          }
        >
          <span className="flex items-center gap-1.5">
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-150',
                open && 'rotate-90'
              )}
              aria-hidden="true"
            />
            {t('settings.integration.browser.trustedExtensions')}
          </span>
          <span>
            {t('settings.integration.browser.trustedSummary', {
              count: items.length,
            })}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('settings.integration.browser.trustedGuidance')}
          </p>

          <div className="overflow-hidden rounded border border-border text-xs">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_6rem_2rem] gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>{t('settings.integration.browser.headerId')}</span>
              <span>{t('settings.integration.browser.headerBrowser')}</span>
              <span>{t('settings.integration.browser.headerSource')}</span>
              <span />
            </div>
            {sorted.length === 0 ? (
              <div className="px-3 py-3 text-center text-muted-foreground">
                {t('settings.integration.browser.trustedEmpty')}
              </div>
            ) : (
              sorted.map((it) => (
                <div
                  key={`${it.browser}:${it.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_8rem_6rem_2rem] items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono">{it.id}</div>
                    {it.label && (
                      <div className="truncate text-muted-foreground">
                        {it.label}
                      </div>
                    )}
                  </div>
                  <span>{browserDisplayName(it.browser)}</span>
                  <Badge
                    variant={it.source === 'builtin' ? 'outline' : 'secondary'}
                    className="justify-self-start rounded text-[10px]"
                  >
                    {t(
                      `settings.integration.browser.sourceLabel.${
                        it.source === 'user-added' ? 'userAdded' : it.source
                      }`
                    )}
                  </Badge>
                  {it.source !== 'builtin' ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => void remove(it.id, it.browser)}
                      aria-label={t(
                        'settings.integration.browser.removeTrusted'
                      )}
                    >
                      <Trash2 />
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
              ))
            )}
          </div>

          <div className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_8.5rem_8rem_4rem] items-start gap-2">
              <Input
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder={idPlaceholder}
                className="h-8 font-mono text-xs"
                aria-label={t(
                  'settings.integration.browser.addTrusted.idPlaceholder'
                )}
              />
              <Select
                items={browserOptions}
                value={newBrowser}
                onValueChange={(value) => {
                  if (value === null) return
                  setNewBrowser(value)
                  setError(null)
                }}
              >
                <SelectTrigger size="sm" className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {browserOptions.map(({ label, value }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t(
                  'settings.integration.browser.addTrusted.labelPlaceholder'
                )}
                className="h-8 text-xs"
                aria-label={t(
                  'settings.integration.browser.addTrusted.labelPlaceholder'
                )}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void handleAdd()}
                disabled={submitting || !newId.trim()}
              >
                {t('settings.integration.browser.addTrusted.addAction')}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
