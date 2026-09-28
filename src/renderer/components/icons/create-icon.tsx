import { cn } from '@renderer/lib/utils'
import {
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  useId,
} from 'react'

export type MotrixIconProps = ComponentPropsWithoutRef<'svg'> & {
  size?: number | string
  title?: string
}
export type MotrixIcon = ForwardRefExoticComponent<
  MotrixIconProps & RefAttributes<SVGSVGElement>
>
type IconGlyph = ComponentType<MotrixIconProps & RefAttributes<SVGSVGElement>>

// Keep creation free of side effects: callers mark it pure for tree shaking.
export function createIcon(
  name: string,
  Glyph: IconGlyph,
  iconSet: string
): MotrixIcon {
  const Icon = forwardRef<SVGSVGElement, MotrixIconProps>(function Icon(
    { title, className, children, ...props },
    ref
  ) {
    const id = useId()
    const named = Boolean(
      title || props['aria-label'] || props['aria-labelledby']
    )

    return (
      <Glyph
        ref={ref}
        className={cn('motrix-icon', className)}
        data-icon={name}
        data-icon-set={iconSet}
        aria-hidden={named ? undefined : true}
        role={named ? 'img' : undefined}
        aria-labelledby={title ? id : undefined}
        {...props}
      >
        {title ? <title id={id}>{title}</title> : null}
        {children}
      </Glyph>
    )
  })
  Icon.displayName = `MotrixIcon(${name})`
  return Icon
}
