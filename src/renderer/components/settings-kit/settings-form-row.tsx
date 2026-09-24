import { FormItem, FormMessage } from '@renderer/components/ui/form'
import type { ReactNode } from 'react'

/** Keep errors below the row without changing its label/control layout. */
export function SettingsFormRow({
  children,
  className = 'flex items-start justify-between gap-4',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <FormItem>
      <div className={className}>{children}</div>
      <FormMessage className="text-xs" />
    </FormItem>
  )
}
