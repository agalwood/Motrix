import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxValue,
  useComboboxAnchor,
} from '@renderer/components/ui/combobox'
import { Input } from '@renderer/components/ui/input'
import type { TrackerSource } from '@shared/types/tracker'
import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

const urlSchema = z.string().url()

interface TrackerSourceComboboxProps {
  sources: TrackerSource[]
  onChange: (next: TrackerSource[]) => void
  testId?: string
}

export function TrackerSourceCombobox({
  sources,
  onChange,
  testId,
}: TrackerSourceComboboxProps) {
  const { t } = useTranslation()
  const anchor = useComboboxAnchor()
  const [newUrl, setNewUrl] = useState('')

  const enabledSources = useMemo(
    () => sources.filter((s) => s.enabled),
    [sources]
  )

  const isValidNewUrl = useMemo(
    () => urlSchema.safeParse(newUrl.trim()).success,
    [newUrl]
  )

  const isDuplicateNewUrl = useMemo(() => {
    const trimmed = newUrl.trim()
    return trimmed.length > 0 && sources.some((s) => s.url === trimmed)
  }, [newUrl, sources])

  const handleAdd = () => {
    if (!isValidNewUrl || isDuplicateNewUrl) return
    const url = newUrl.trim()
    onChange([
      ...sources,
      {
        id: `custom-${Date.now()}`,
        label: url,
        url,
        builtin: false,
        enabled: true,
        cdn: false,
      },
    ])
    setNewUrl('')
  }

  const handleDelete = (id: string) => {
    onChange(sources.filter((s) => s.id !== id))
  }

  return (
    <Combobox
      multiple
      items={sources}
      itemToStringLabel={(s: TrackerSource) => s.label}
      value={enabledSources}
      onValueChange={(next) => {
        const enabledIdSet = new Set((next as TrackerSource[]).map((s) => s.id))
        onChange(
          sources.map((s) => ({ ...s, enabled: enabledIdSet.has(s.id) }))
        )
      }}
    >
      <ComboboxChips
        ref={anchor}
        className="w-full bg-background"
        data-testid={testId}
      >
        <ComboboxValue>
          {(values: TrackerSource[]) => (
            <>
              {values.map((s) => (
                <ComboboxChip key={s.id} aria-label={s.label}>
                  {s.label}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                placeholder={
                  values.length === 0 ? t('trackers.combobox.placeholder') : ''
                }
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{t('trackers.combobox.empty')}</ComboboxEmpty>
        <ComboboxList>
          {(s: TrackerSource) => (
            <ComboboxItem key={s.id} value={s}>
              <span className="flex-1 truncate text-sm">{s.label}</span>
              {s.builtin && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t('trackers.combobox.builtinBadge')}
                </span>
              )}
              {s.cdn && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t('trackers.combobox.cdnBadge')}
                </span>
              )}
              {!s.builtin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('trackers.combobox.removeSource')}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(s.id)
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <Trash2 className="text-destructive" />
                </Button>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxSeparator />
        <div className="flex items-center gap-2 p-2">
          <Input
            type="url"
            className="h-8 flex-1"
            placeholder={t('trackers.combobox.addSourcePlaceholder')}
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            aria-label={t('trackers.combobox.addSource')}
            onClick={handleAdd}
            disabled={!isValidNewUrl || isDuplicateNewUrl}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  )
}
