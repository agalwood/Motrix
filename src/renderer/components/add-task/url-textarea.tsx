import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import {
  type ClipboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { type FieldPath, useController, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { builtinInterpreters } from './url-interpreters'
import { parseUrlLines } from './url-interpreters/multiline-url'
import type { InterpretResult } from './url-interpreters/types'

// Paste replaces the selected range natively; a caret-at-end paste on a
// non-empty textarea appends with a newline separator so pasted URLs
// land on their own line (the URL-list UX contract for this field).
function spliceUrls(
  existing: string,
  pasted: string,
  range?: { start: number; end: number }
): string {
  if (range && range.start !== range.end) {
    return existing.slice(0, range.start) + pasted + existing.slice(range.end)
  }
  if (range && range.start < existing.length) {
    return existing.slice(0, range.start) + pasted + existing.slice(range.start)
  }
  const trimmed = existing.trim()
  return trimmed ? `${trimmed}\n${pasted}` : pasted
}

interface UrlTextareaProps {
  name: FieldPath<AddTaskFormValues>
  autoFocus?: boolean
}

export function UrlTextarea({ name, autoFocus }: UrlTextareaProps) {
  const { t } = useTranslation()
  const platform = usePlatformServices()
  const { setValue, getValues } = useFormContext<AddTaskFormValues>()
  const { field } = useController<AddTaskFormValues>({ name })

  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const parsed = useMemo(
    () => parseUrlLines(String(field.value ?? '')),
    [field.value]
  )
  const valid = parsed.filter((p) => p.valid).length
  const invalid = parsed.length - valid

  const counter = useMemo(() => {
    if (parsed.length === 0) return ''
    if (invalid > 0) {
      return t('task.add.urlsWithInvalid', { valid, invalid })
    }
    return t('task.add.urlsCount', { count: valid })
  }, [parsed.length, valid, invalid, t])

  const applyResult = useCallback(
    (result: InterpretResult, pasteRange?: { start: number; end: number }) => {
      if (result.switchToTab === 'torrent' && result.magnetUri) {
        setValue('tab', 'torrent', { shouldDirty: true })
        setValue('source' as never, 'magnet' as never, { shouldDirty: true })
        setValue('magnetUri' as never, result.magnetUri as never, {
          shouldDirty: true,
        })
        return
      }
      if (result.urls && result.urls.length > 0) {
        const existing = String(getValues(name) ?? '')
        const pasted = result.urls.join('\n')
        const next = spliceUrls(existing, pasted, pasteRange)
        setValue(name, next as never, {
          shouldDirty: true,
          shouldValidate: true,
        })
      }
      if (result.headers) {
        const map: Record<string, keyof AddTaskFormValues> = {
          'User-Agent': 'userAgent' as never,
          Referer: 'referer' as never,
          Cookie: 'cookie' as never,
          Authorization: 'authorization' as never,
        }
        for (const [hName, hValue] of Object.entries(result.headers)) {
          const target = map[hName]
          if (target) {
            setValue(target as never, hValue as never, { shouldDirty: true })
          }
        }
      }
      if (result.proxy) {
        setValue('allProxy' as never, result.proxy as never, {
          shouldDirty: true,
        })
      }
      if (result.filename) {
        setValue('filename' as never, result.filename as never, {
          shouldDirty: true,
        })
      }
    },
    [setValue, getValues, name]
  )

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData?.getData('text') ?? ''
      if (!text) return
      const target = e.currentTarget
      const range = {
        start: target.selectionStart,
        end: target.selectionEnd,
      }
      for (const interp of builtinInterpreters) {
        const result = interp.tryInterpret(text)
        if (!result) continue
        // Only intercept when the interpreter produces side effects beyond
        // the urls field (magnet tab switch, curl headers/proxy/filename,
        // toast). A urls-only result means the pasted text IS the urls
        // field — let native paste handle it so selection semantics match
        // a plain textarea (replace selection, clear it, preserve any
        // invalid lines the user can then edit inline).
        const hasSideEffects =
          result.switchToTab !== undefined ||
          result.magnetUri !== undefined ||
          result.headers !== undefined ||
          result.proxy !== undefined ||
          result.filename !== undefined ||
          result.userNotice !== undefined
        if (!hasSideEffects) return
        e.preventDefault()
        applyResult(result, range)
        if (result.userNotice) {
          platform.notify(result.userNotice.kind, result.userNotice.messageKey)
        }
        return
      }
    },
    [applyResult, platform]
  )

  return (
    <div className="space-y-1">
      <InputGroup>
        <InputGroupTextarea
          ref={ref}
          value={String(field.value ?? '')}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
          onPaste={handlePaste}
          placeholder={t('task.add.urlPlaceholder')}
          rows={4}
          className="text-sm min-h-24"
          aria-label={t('task.add.urlsLabel')}
        />
        <InputGroupAddon align="block-end">
          <InputGroupText
            className={cn(
              'tabular-nums',
              invalid > 0 ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {counter}
          </InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
