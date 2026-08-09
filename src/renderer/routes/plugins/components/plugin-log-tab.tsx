import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { ListFilter, TerminalSquare, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginLogStream } from '../hooks/use-plugin-log-stream'
import { PluginLogRow } from './plugin-log-row'

const LEVELS = [
  'all',
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const

export function PluginLogTab({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation()
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('all')
  const [verbose, setVerbose] = useState(false)
  const { entries, setEntries } = usePluginLogStream(pluginId)
  const levelOptions = LEVELS.map((value) => ({
    value,
    label: t(`plugins.logs.levels.${value}`),
  }))

  const filtered =
    level === 'all' ? entries : entries.filter((e) => e.level === level)

  async function onVerboseChange(v: boolean) {
    setVerbose(v)
    await transport.invoke(Commands.SetPluginLogVerbose, {
      pluginId,
      verbose: v,
    })
  }

  async function onClear() {
    await transport.invoke(Commands.ClearPluginLogs, { pluginId })
    setEntries([])
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Select
          items={levelOptions}
          value={level}
          onValueChange={(value) => {
            if (value !== null) setLevel(value)
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t('plugins.logs.filterLabel')}
            className="h-7 w-32 rounded-md bg-background px-2.5 text-xs shadow-none"
          >
            <ListFilter className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {levelOptions.map(({ label, value }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <label
          htmlFor="plugin-log-verbose"
          className="flex h-7 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <Switch
            id="plugin-log-verbose"
            size="sm"
            checked={verbose}
            onCheckedChange={onVerboseChange}
          />
          <span>{t('plugins.logs.verbose')}</span>
        </label>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 rounded-md border border-border/70 bg-background/80 p-0.5 shadow-xs">
          <CopyButton
            size="xs"
            variant="ghost"
            disabled={filtered.length === 0}
            content={JSON.stringify(filtered, null, 2)}
            className="active:scale-[0.97] motion-reduce:transform-none"
          >
            {t('plugins.logs.copy')}
          </CopyButton>
          <Separator orientation="vertical" className="h-3.5" />
          <Button
            size="xs"
            variant="ghost"
            disabled={entries.length === 0}
            onClick={onClear}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:scale-[0.97] motion-reduce:transform-none dark:hover:bg-destructive/15"
          >
            <Trash2 className="size-3" />
            {t('plugins.logs.clear')}
          </Button>
        </div>
      </div>

      {verbose && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('plugins.logs.verboseWarning')}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 bg-muted/30 px-3">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <TerminalSquare className="size-3.5 text-muted-foreground" />
            <span>{t('plugins.logs.output')}</span>
          </div>
          <span
            aria-live="polite"
            className="text-[11px] tabular-nums text-muted-foreground"
          >
            {t('plugins.logs.entryCount', { count: filtered.length })}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-background/80 shadow-xs">
                <TerminalSquare className="size-4.5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium tracking-tight text-foreground">
                {entries.length === 0
                  ? t('plugins.logs.empty')
                  : t('plugins.logs.emptyFiltered')}
              </p>
              {entries.length === 0 && (
                <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {t('plugins.logs.emptyHint')}
                </p>
              )}
            </div>
          ) : (
            filtered.map((e) => (
              <PluginLogRow key={`${e.ts}-${e.level}-${e.msg}`} entry={e} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
