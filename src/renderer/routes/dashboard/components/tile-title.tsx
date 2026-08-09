import { cn } from '@renderer/lib/utils'
import type { ComponentProps, ReactNode } from 'react'
import { KpiNumber, type KpiNumberProps } from './kpi-number'

type TileTitleBaseProps = Omit<
  ComponentProps<'div'>,
  'children' | 'className' | 'dangerouslySetInnerHTML' | 'style'
>

export type TileTitleProps = TileTitleBaseProps &
  (
    | {
        children?: never
        value: KpiNumberProps['value']
        variant?: 'metric'
      }
    | {
        children: string | number
        value?: never
        variant: 'text'
      }
  )

function TileTitleBox({
  rendered,
  variant,
  ...props
}: TileTitleBaseProps & {
  rendered: ReactNode
  variant: 'metric' | 'text'
}) {
  return (
    <div
      {...props}
      data-slot="tile-title"
      className={cn(
        'flex min-w-0 max-w-full shrink items-center font-semibold',
        'h-8',
        variant === 'text' ? 'text-[22px]' : 'text-[32px]',
        'leading-none'
      )}
    >
      {variant === 'text' ? (
        <span className="block min-w-0 max-w-full truncate leading-[26px]">
          {rendered}
        </span>
      ) : (
        rendered
      )}
    </div>
  )
}

export function TileTitle(props: TileTitleProps) {
  if (props.variant === 'text') {
    const { children, variant, ...titleProps } = props
    return (
      <TileTitleBox {...titleProps} rendered={children} variant={variant} />
    )
  }

  const { value, variant = 'metric', ...titleProps } = props
  return (
    <TileTitleBox
      {...titleProps}
      rendered={<KpiNumber value={value} variant="inherit" />}
      variant={variant}
    />
  )
}
