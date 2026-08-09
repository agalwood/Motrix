import type { CallGraphTableRow } from '../../lib/call-graph-model'

export interface PluginCallGraphTableStrings {
  tableRegionLabel: string
  tableLabel: string
  caller: string
  command: string
  callee: string
  calls: string
  lastCall: string
  filteredEmpty: string
  formatLastCall: (timestamp: number) => string
}

export interface PluginCallGraphTableProps {
  rows: ReadonlyArray<CallGraphTableRow>
  strings: PluginCallGraphTableStrings
}

function Identifier({ value }: { value: string }) {
  return (
    <code className="break-all text-xs text-foreground">
      <bdi dir="ltr">{value}</bdi>
    </code>
  )
}

function PluginIdentity({ name, id }: { name: string; id: string }) {
  return (
    <span className="block min-w-40">
      {name !== id && <span className="block text-sm">{name}</span>}
      <Identifier value={id} />
    </span>
  )
}

export function PluginCallGraphTable({
  rows,
  strings,
}: PluginCallGraphTableProps) {
  return (
    <section
      aria-label={strings.tableRegionLabel}
      className="flex min-h-0 flex-1 overflow-auto rounded-md border border-border"
    >
      <table className="min-w-full border-separate border-spacing-0 text-left">
        <caption className="sr-only">{strings.tableLabel}</caption>
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground"
            >
              {strings.caller}
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground"
            >
              {strings.command}
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground"
            >
              {strings.callee}
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-right text-xs font-medium text-muted-foreground"
            >
              {strings.calls}
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-right text-xs font-medium text-muted-foreground"
            >
              {strings.lastCall}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-8 text-center text-sm text-muted-foreground"
              >
                {strings.filteredEmpty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={JSON.stringify([
                  row.sourcePluginId,
                  row.targetPluginId,
                  row.commandId,
                ])}
                className="align-top"
              >
                <td className="border-b border-border px-3 py-2.5">
                  <PluginIdentity
                    name={row.sourcePluginName}
                    id={row.sourcePluginId}
                  />
                </td>
                <td className="border-b border-border px-3 py-2.5">
                  <Identifier value={row.commandId} />
                </td>
                <td className="border-b border-border px-3 py-2.5">
                  <PluginIdentity
                    name={row.targetPluginName}
                    id={row.targetPluginId}
                  />
                </td>
                <td className="border-b border-border px-3 py-2.5 text-right text-sm tabular-nums">
                  {row.calls}
                </td>
                <td className="border-b border-border px-3 py-2.5 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                  <time dateTime={new Date(row.lastCalledAt).toISOString()}>
                    {strings.formatLastCall(row.lastCalledAt)}
                  </time>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  )
}
