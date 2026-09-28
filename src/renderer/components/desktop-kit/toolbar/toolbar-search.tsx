import { Toolbar as ToolbarPrimitive } from '@base-ui/react/toolbar'
import { SearchIcon, StatusFailedIcon } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useCompactHeader } from '../hooks/use-compact-header'
import { ToolbarButton } from './toolbar-button'
import { ToolbarGroup } from './toolbar-group'

export interface ToolbarSearchAccessory {
  anchorRef: RefObject<HTMLDivElement | null>
  collapseIfIdle: () => void
}

export interface ToolbarSearchProps {
  value: string
  onValueChange: (value: string) => void
  label: string
  clearLabel: string
  placeholder?: string
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Keep filters or a portaled popup visible even when the query is empty. */
  keepExpanded?: boolean
  onEmptyEscape?: () => void
  leading?: (accessory: ToolbarSearchAccessory) => ReactNode
  width?: number
  'data-slot'?: string
  'data-filter-active'?: boolean
}

/** Shared disclosure, focus, clear and Escape behavior for panel searches. */
export function ToolbarSearch({
  value,
  onValueChange,
  label,
  clearLabel,
  placeholder = label,
  expanded: controlledExpanded,
  onExpandedChange,
  keepExpanded = false,
  onEmptyEscape,
  leading,
  width = 230,
  ...props
}: ToolbarSearchProps) {
  const compact = useCompactHeader()
  const [requested, setRequested] = useState(false)
  const expanded =
    (controlledExpanded ?? requested) || Boolean(value.trim()) || keepExpanded
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusOnExpand = useRef(false)
  const returnFocus = useRef(false)
  const blurFrame = useRef<number | null>(null)
  const inputId = useId()
  const latest = useRef({ value, keepExpanded })
  latest.current = { value, keepExpanded }
  const requestExpanded = (next: boolean) => {
    setRequested(next)
    onExpandedChange?.(next)
  }
  const collapseIfIdle = () => {
    if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current)
    blurFrame.current = requestAnimationFrame(() => {
      if (
        !latest.current.value.trim() &&
        !latest.current.keepExpanded &&
        !rootRef.current?.contains(document.activeElement)
      )
        requestExpanded(false)
    })
  }
  useEffect(
    () => () => {
      if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current)
    },
    []
  )
  useLayoutEffect(() => {
    if (expanded && focusOnExpand.current) {
      inputRef.current?.focus()
      focusOnExpand.current = false
    } else if (!expanded && returnFocus.current) {
      triggerRef.current?.focus()
      returnFocus.current = false
    }
  }, [expanded])

  return (
    <ToolbarGroup
      ref={rootRef}
      data-slot="toolbar-search"
      data-expanded={expanded}
      {...props}
      onBlurCapture={(event) => {
        if (rootRef.current?.contains(event.target)) collapseIfIdle()
      }}
      className={cn(
        'gap-0 transition-[width] duration-150 ease-out motion-reduce:transition-none',
        expanded &&
          'min-w-20 shrink has-[input:focus]:border-[#7388a3] dark:has-[input:focus]:border-[#97aac4]'
      )}
      style={{ width: expanded ? width : compact ? 30 : 36 }}
    >
      {expanded ? (
        <>
          {leading ? (
            leading({ anchorRef: rootRef, collapseIfIdle })
          ) : (
            <SearchIcon
              aria-hidden="true"
              className="mx-2 size-4 shrink-0 text-muted-foreground"
            />
          )}
          <ToolbarPrimitive.Input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="search"
            aria-label={label}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onFocus={() => requestExpanded(true)}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing)
                return
              event.preventDefault()
              event.stopPropagation()
              if (value) onValueChange('')
              else if (!keepExpanded) {
                returnFocus.current = true
                requestExpanded(false)
              } else onEmptyEscape?.()
            }}
            className="h-[30px] w-full min-w-0 border-0 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground compact-header:h-6 compact-header:text-xs"
          />
          {value.length > 0 && (
            <ToolbarButton
              label={clearLabel}
              onClick={() => {
                onValueChange('')
                inputRef.current?.focus()
              }}
            >
              <StatusFailedIcon aria-hidden="true" />
            </ToolbarButton>
          )}
        </>
      ) : (
        <ToolbarButton
          ref={triggerRef}
          label={label}
          aria-expanded={false}
          onClick={() => {
            focusOnExpand.current = true
            requestExpanded(true)
          }}
        >
          <SearchIcon aria-hidden="true" />
        </ToolbarButton>
      )}
    </ToolbarGroup>
  )
}
