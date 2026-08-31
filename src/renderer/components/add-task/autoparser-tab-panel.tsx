import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { FileList } from '@renderer/components/file-list/file-list'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { transport } from '@renderer/lib/transport'
import {
  deriveAutoparserDirName,
  joinParentDir,
} from '@shared/autoparser/dir-name'
import { Commands } from '@shared/protocol/commands'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type {
  PageLinkResource,
  ParsePageLinksResult,
} from '@shared/schemas/page-parse'
import { Search } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { AdvancedPanel } from './advanced-panel'

/** Row shape FileList renders; `path` carries the link's filename. */
interface PageLinkRow extends Omit<PageLinkResource, 'size'> {
  path: string
  size: number
}

function toRows(links: readonly PageLinkResource[]): PageLinkRow[] {
  return links.map((link) => ({
    ...link,
    path: link.filename,
    // AutoParser deliberately skips HEAD probes, so size may be unknown.
    size: link.size ?? 0,
  }))
}

export function AutoparserTabPanel() {
  const { t } = useTranslation()
  const { getValues, setValue } = useFormContext<AddTaskFormValues>()
  const pageUrl = useWatch<AddTaskFormValues, 'pageUrl'>({ name: 'pageUrl' })
  const parseResult = useWatch<AddTaskFormValues, 'parseResult'>({
    name: 'parseResult',
  })
  const selectedLinks = useWatch<AddTaskFormValues, 'selectedLinks'>({
    name: 'selectedLinks',
  })
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  const handleParse = useCallback(async () => {
    const url = String(getValues('pageUrl') ?? '').trim()
    if (!url || parsing) return
    setParsing(true)
    setParseError(null)
    try {
      // Advanced options double as request headers for the page fetch.
      const headers: Array<{ name: string; value: string }> = []
      const userAgent = String(getValues('userAgent') ?? '').trim()
      const cookie = String(getValues('cookie') ?? '').trim()
      const authorization = String(getValues('authorization') ?? '').trim()
      if (userAgent) headers.push({ name: 'User-Agent', value: userAgent })
      if (cookie) headers.push({ name: 'Cookie', value: cookie })
      if (authorization) {
        headers.push({ name: 'Authorization', value: authorization })
      }
      const result = (await transport.invoke(Commands.ParsePageLinks, {
        url,
        headers,
      })) as ParsePageLinksResult
      setValue('parseResult' as never, result as never, {
        shouldDirty: true,
      })
      // Mirror the torrent tab: everything discovered starts selected.
      setValue(
        'selectedLinks' as never,
        result.links.map((l) => l.index) as never,
        { shouldDirty: true, shouldValidate: true }
      )
      // Auto-suggest a subdirectory under the current save directory derived
      // from the parsed page (e.g. unsloth_Qwen3.8-27B-GGUF). The directory
      // itself is created on submit by prepareSaveDir. Keep the user's path
      // when nothing meaningful can be derived or no save dir is selected.
      const subdir = deriveAutoparserDirName(result.finalUrl || url)
      if (subdir) {
        const parent = String(getValues('saveDir') ?? '').trim()
        if (parent) {
          setValue('saveDir' as never, joinParentDir(parent, subdir) as never, {
            shouldDirty: true,
          })
        }
      }
    } catch {
      setParseError(t('task.add.autoparser.parseFailed'))
    } finally {
      setParsing(false)
    }
  }, [getValues, parsing, setValue, t])

  const handleSelection = useCallback(
    (ids: number[]) => {
      setValue('selectedLinks' as never, ids as never, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [setValue]
  )

  const rows = parseResult ? toRows(parseResult.links) : []

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          value={String(pageUrl ?? '')}
          onChange={(e) =>
            setValue('pageUrl' as never, e.target.value as never, {
              shouldDirty: true,
            })
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleParse()
            }
          }}
          placeholder={t('task.add.autoparser.placeholder')}
          aria-label={t('task.add.autoparser.label')}
          inputMode="url"
          className="h-9 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleParse()}
          disabled={parsing || !String(pageUrl ?? '').trim()}
          className="h-9 shrink-0 gap-1.5 px-3"
        >
          {parsing ? (
            <Spinner className="size-3.5" />
          ) : (
            <Search className="size-3.5" aria-hidden="true" />
          )}
          {t('task.add.autoparser.parse')}
        </Button>
      </div>

      {parseError && (
        <p className="text-xs text-destructive" role="alert">
          {parseError}
        </p>
      )}

      {parseResult && (
        <div className="flex min-h-[200px] max-h-[calc(100vh-380px)] min-w-0 flex-1 overflow-hidden rounded-md border border-border">
          {rows.length > 0 ? (
            <FileList<PageLinkRow>
              files={rows}
              selectedIndices={selectedLinks ?? []}
              onSelectionChange={handleSelection}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {t('task.add.autoparser.empty')}
            </div>
          )}
        </div>
      )}

      <DirectoryPicker
        name="saveDir"
        variant="compact"
        prefixLabel={t('task.add.saveTo')}
        placeholder={t('task.add.saveDirEmpty')}
      />
      <AdvancedPanel />
    </div>
  )
}
