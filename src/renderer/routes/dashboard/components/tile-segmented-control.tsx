import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import {
  forwardRef,
  type KeyboardEvent,
  type ReactElement,
  type RefAttributes,
  useRef,
} from 'react'

export interface TileSegmentOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface TileSegmentedControlProps<T extends string> {
  ariaLabel: string
  value: T
  options: readonly TileSegmentOption<T>[]
  disabled?: boolean
  onValueChange: (value: T) => void
}

function documentDirection(element: HTMLElement): 'ltr' | 'rtl' {
  const declaredDirection = element.closest<HTMLElement>('[dir]')?.dir
  if (declaredDirection === 'rtl') return 'rtl'
  if (declaredDirection === 'ltr') return 'ltr'
  return getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr'
}

const ForwardedTileSegmentedControl = forwardRef<
  HTMLDivElement,
  TileSegmentedControlProps<string>
>(function TileSegmentedControl(
  { ariaLabel, value, options, disabled = false, onValueChange },
  ref
) {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const enabledOptions = disabled
    ? []
    : options.filter((option) => !option.disabled)
  const selectedIsEnabled = enabledOptions.some(
    (option) => option.value === value
  )
  const tabStopValue = selectedIsEnabled
    ? value
    : (enabledOptions[0]?.value ?? null)

  function requestValueChange(nextValue: string): void {
    if (disabled || nextValue === value) return
    const option = options.find((candidate) => candidate.value === nextValue)
    if (!option || option.disabled) return
    onValueChange(nextValue)
  }

  function focusAndSelect(nextValue: string | undefined): void {
    if (!nextValue) return
    requestValueChange(nextValue)
    optionRefs.current.get(nextValue)?.focus()
  }

  function adjacentEnabledValue(
    currentValue: string,
    step: 1 | -1
  ): string | undefined {
    if (enabledOptions.length === 0) return undefined
    const currentIndex = options.findIndex(
      (option) => option.value === currentValue
    )
    const startIndex = currentIndex >= 0 ? currentIndex : 0

    for (let offset = 1; offset <= options.length; offset += 1) {
      const index =
        (startIndex + step * offset + options.length) % options.length
      const candidate = options[index]
      if (candidate && !candidate.disabled) return candidate.value
    }
    return undefined
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    optionValue: string
  ): void {
    if (disabled) return

    let nextValue: string | undefined
    switch (event.key) {
      case 'ArrowLeft':
        nextValue = adjacentEnabledValue(
          optionValue,
          documentDirection(event.currentTarget) === 'rtl' ? 1 : -1
        )
        break
      case 'ArrowRight':
        nextValue = adjacentEnabledValue(
          optionValue,
          documentDirection(event.currentTarget) === 'rtl' ? -1 : 1
        )
        break
      case 'ArrowUp':
        nextValue = adjacentEnabledValue(optionValue, -1)
        break
      case 'ArrowDown':
        nextValue = adjacentEnabledValue(optionValue, 1)
        break
      case 'Home':
        nextValue = enabledOptions[0]?.value
        break
      case 'End':
        nextValue = enabledOptions.at(-1)?.value
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        requestValueChange(optionValue)
        return
      default:
        return
    }

    event.preventDefault()
    focusAndSelect(nextValue)
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-slot="tile-segmented-control"
      className="flex w-fit items-stretch rounded-md bg-muted/70 p-0.5 [&>*]:focus-visible:relative [&>*]:focus-visible:z-10"
    >
      {options.map((option) => {
        const optionDisabled = disabled || option.disabled === true
        const selected = option.value === value

        return (
          <Button
            key={option.value}
            ref={(element) => {
              if (element) {
                optionRefs.current.set(option.value, element)
              } else {
                optionRefs.current.delete(option.value)
              }
            }}
            type="button"
            role="radio"
            size="xs"
            variant="ghost"
            disabled={optionDisabled}
            aria-checked={selected}
            tabIndex={option.value === tabStopValue ? 0 : -1}
            className={cn(
              "relative h-5 rounded-md! border-0 px-2 text-[10px] shadow-none after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] motion-reduce:transition-none",
              selected &&
                'bg-background text-foreground shadow-xs hover:bg-background dark:hover:bg-background'
            )}
            onClick={() => requestValueChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
})

ForwardedTileSegmentedControl.displayName = 'TileSegmentedControl'

type TileSegmentedControlComponent = <T extends string>(
  props: TileSegmentedControlProps<T> & RefAttributes<HTMLDivElement>
) => ReactElement

export const TileSegmentedControl =
  ForwardedTileSegmentedControl as TileSegmentedControlComponent
