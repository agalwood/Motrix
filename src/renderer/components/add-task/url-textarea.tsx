import { Button } from '@renderer/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
} from '@renderer/components/ui/input-group'
import { usePlatformServices } from '@renderer/platform/services'
import type { DownloadInputLine } from '@shared/lib/download-source-input'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { SourceCorrection } from '@shared/schemas/download-source'
import {
  infoHashToMagnetUri,
  normalizeMagnetInputLines,
} from '@shared/schemas/magnet-input'
import {
  type ClipboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type FieldPath, useController, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { UrlEditor } from './url-editor'
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
  const { setValue, getValues, clearErrors, formState } =
    useFormContext<AddTaskFormValues>()
  const { field, fieldState } = useController<AddTaskFormValues>({ name })
  const statusId = useId()
  const errorId = useId()
  const [correctionHistory, setCorrectionHistory] = useState<
    Array<{ before: string; after: string }>
  >([])

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
  const errorMessage = parsed.length > 0 ? fieldState.error?.message : undefined

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
          const canonicalName = Object.keys(map).find(
            (key) => key.toLowerCase() === hName.toLowerCase()
          )
          const target = canonicalName ? map[canonicalName] : undefined
          if (target) {
            setValue(target as never, hValue as never, { shouldDirty: true })
          }
        }
        setValue(
          'extraHeaders',
          Object.entries(result.headers)
            .filter(
              ([name]) =>
                !Object.keys(map).some(
                  (key) => key.toLowerCase() === name.toLowerCase()
                )
            )
            .map(([name, value]) => ({ name, value })),
          { shouldDirty: true }
        )
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
      // A hash pasted into an existing URL may be a path or query value.
      // Expand only when it occupies an entire line after the selection is replaced.
      if (infoHashToMagnetUri(text)) {
        const before = target.value.slice(0, range.start).split('\n').at(-1)
        const after = target.value.slice(range.end).split('\n')[0]
        if (`${before}${after}`.trim()) return
      }
      for (const interp of builtinInterpreters) {
        const result = interp.tryInterpret(text)
        if (!result) continue
        if (result.rejected) {
          if (result.userNotice)
            platform.notify(
              result.userNotice.kind,
              result.userNotice.messageKey
            )
          return
        }
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

  const correctLine = (
    line: DownloadInputLine,
    correction: SourceCorrection
  ) => {
    const current = String(getValues(name) ?? '')
    if (current !== String(field.value ?? '')) return
    // Apply deferred hash expansion only after the correction has been chosen.
    const before = normalizeMagnetInputLines(current)
    const after = normalizeMagnetInputLines(
      current.slice(0, line.start) + correction.url + current.slice(line.end)
    )
    setCorrectionHistory((history) => [
      ...history.slice(-19),
      { before, after },
    ])
    field.onChange(after)
    ref.current?.focus()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: observes focus leaving child controls without adding an interactive target
    <div
      className="space-y-1"
      onBlur={(e) => {
        // Treat the input, diagnostics and portaled corrections as one editor.
        if (
          e.relatedTarget instanceof HTMLElement &&
          (e.currentTarget.contains(e.relatedTarget) ||
            e.relatedTarget.closest('[data-url-correction]'))
        )
          return
        const value = String(getValues(name) ?? '')
        if (!value.trim()) return
        const normalized = normalizeMagnetInputLines(value)
        if (normalized !== value) field.onChange(normalized)
        field.onBlur()
      }}
    >
      <InputGroup className="h-auto flex-col !border-input !ring-ring/50 has-[[data-slot=input-group-control]:focus-visible]:!border-ring">
        <UrlEditor
          controlRef={ref}
          lines={parsed}
          onCorrect={correctLine}
          value={String(field.value ?? '')}
          disabled={formState.isSubmitting}
          onChange={(e) => {
            const value = e.target.value
            if (value.trim()) {
              field.onChange(value)
              return
            }
            // An empty draft is idle, even after this field has been touched.
            setValue(name, value as never, { shouldDirty: true })
            clearErrors(name)
          }}
          onPaste={handlePaste}
          placeholder={t('task.add.urlPlaceholder')}
          rows={3}
          aria-label={t('task.add.urlsLabel')}
          aria-invalid={invalid > 0 || Boolean(errorMessage)}
          aria-describedby={`${statusId}${errorMessage ? ` ${errorId}` : ''}`}
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between pt-0 pb-2"
        >
          <InputGroupText
            id={statusId}
            role="status"
            aria-label={counter}
            className="min-h-4 gap-1.5 text-xs tabular-nums text-muted-foreground"
          >
            {invalid > 0 ? (
              <>
                <span>{t('task.add.validUrlCount', { count: valid })}</span>
                <span aria-hidden="true">·</span>
                <span className="text-destructive">
                  {t('task.add.invalidUrlCount', { count: invalid })}
                </span>
              </>
            ) : (
              counter
            )}
          </InputGroupText>
          {correctionHistory.at(-1)?.after === String(field.value ?? '') && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-4 shrink-0 p-0 text-xs"
              disabled={formState.isSubmitting}
              onClick={() => {
                const last = correctionHistory.at(-1)
                if (!last || String(getValues(name) ?? '') !== last.after)
                  return
                field.onChange(last.before)
                setCorrectionHistory((history) => history.slice(0, -1))
              }}
            >
              {t('task.add.undoCorrection')}
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      {errorMessage && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {t(errorMessage)}
        </p>
      )}
    </div>
  )
}
