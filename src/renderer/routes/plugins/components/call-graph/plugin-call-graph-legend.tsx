export interface PluginCallGraphLegendStrings {
  label: string
  fewerCalls: string
  moreCalls: string
}

export function PluginCallGraphLegend({
  strings,
}: {
  strings: PluginCallGraphLegendStrings
}) {
  return (
    <fieldset
      aria-label={strings.label}
      className="pointer-events-none flex items-center gap-3 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-xs"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          data-testid="call-volume-thin"
          aria-hidden="true"
          className="h-[2px] w-6 rounded-full bg-muted-foreground"
        />
        <span>{strings.fewerCalls}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          data-testid="call-volume-thick"
          aria-hidden="true"
          className="h-[6px] w-6 rounded-full bg-muted-foreground"
        />
        <span>{strings.moreCalls}</span>
      </span>
    </fieldset>
  )
}
