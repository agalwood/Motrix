import { cn } from '@renderer/lib/utils'
import type { PluginLogEntry } from '@shared/types/plugin'

const LEVEL_CLASS: Record<PluginLogEntry['level'], string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
  fatal: 'text-destructive font-semibold',
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return d.toISOString().slice(11, 23)
}

export function PluginLogRow({ entry }: { entry: PluginLogEntry }) {
  const extraFields = Object.entries(entry).filter(
    ([k]) => k !== 'ts' && k !== 'level' && k !== 'msg'
  )
  return (
    <div className="grid grid-cols-[5.25rem_3.5rem_minmax(0,1fr)] items-start border-b border-border/50 px-3 py-2 font-mono text-[11px] leading-4 transition-colors last:border-b-0 hover:bg-muted/25">
      <time
        dateTime={new Date(entry.ts).toISOString()}
        className="tabular-nums text-muted-foreground"
      >
        {formatTs(entry.ts)}
      </time>
      <span
        className={cn(
          'font-semibold uppercase tracking-wide',
          LEVEL_CLASS[entry.level]
        )}
      >
        {entry.level}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
        {entry.msg}
        {extraFields.length > 0 && (
          <span className="ml-2 text-muted-foreground">
            {extraFields
              .map(
                ([k, v]) =>
                  `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
              )
              .join(' ')}
          </span>
        )}
      </span>
    </div>
  )
}
