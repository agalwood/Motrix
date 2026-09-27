import { ArrowLeftIcon, ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { captureTaskMenuIntent } from '@renderer/features/application-menu/task-context'
import { WebMenuButton } from '@renderer/features/application-menu/web-menu-button'
import { useApplicationMenu } from '@renderer/hooks/use-application-menu'
import { useSelectedTask } from '@renderer/hooks/use-selected-task'
import { transport } from '@renderer/lib/transport'
import type {
  ApplicationMenuNode,
  ExecuteApplicationMenuItemRequest,
} from '@shared/schemas/application-menu'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { MotrixLogo } from './motrix-logo'

type RendererMenuPlatform = 'darwin' | 'win32' | 'linux'

function rendererMenuPlatform(): RendererMenuPlatform | null {
  if (__MOTRIX_TARGET__ !== 'electron') return null
  return transport.platform === 'win32' ||
    transport.platform === 'linux' ||
    (transport.platform === 'darwin' && __MOTRIX_PREVIEW_MAC_MENU__)
    ? transport.platform
    : null
}

const ACCELERATOR_LABELS: Readonly<Record<string, string>> = {
  alt: 'Alt',
  cmd: 'Ctrl',
  cmdorctrl: 'Ctrl',
  command: 'Ctrl',
  commandorcontrol: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  option: 'Alt',
  return: 'Enter',
  shift: 'Shift',
}

export function formatMenuAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => ACCELERATOR_LABELS[part.trim().toLowerCase()] ?? part.trim())
    .join('+')
}

export function shouldRestoreMenuFocus(reason: string): boolean {
  return reason === 'item-press' || reason === 'escape-key'
}

function modifiersFromEvent(
  event: ReactMouseEvent<HTMLElement>
): ExecuteApplicationMenuItemRequest['modifiers'] {
  return {
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  }
}

interface MenuTreeProps {
  enterSubmenu?: (item: ApplicationMenuNode) => void
  items: ApplicationMenuNode[]
  queueExecution: (
    item: ApplicationMenuNode,
    event: ReactMouseEvent<HTMLElement>
  ) => void
}

function ItemLabel({ item }: { item: ApplicationMenuNode }) {
  return (
    <>
      <span>{item.label}</span>
      {item.accelerator && (
        <DropdownMenuShortcut className="opacity-60">
          {formatMenuAccelerator(item.accelerator)}
        </DropdownMenuShortcut>
      )}
    </>
  )
}

function RadioItems({
  items,
  queueExecution,
}: {
  items: ApplicationMenuNode[]
  queueExecution: MenuTreeProps['queueExecution']
}) {
  const checkedItem = items.find((item) => item.checked)
  return (
    <DropdownMenuRadioGroup value={checkedItem?.id ?? ''}>
      {items.map((item) => (
        <DropdownMenuRadioItem
          key={item.id}
          value={item.id}
          disabled={!item.enabled}
          closeOnClick
          onClick={(event) => queueExecution(item, event)}
        >
          <ItemLabel item={item} />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function MenuTree({ items, queueExecution, enterSubmenu }: MenuTreeProps) {
  const visibleItems = items.filter((item) => item.visible)
  const rendered: ReactNode[] = []

  for (let index = 0; index < visibleItems.length; index += 1) {
    const item = visibleItems[index]
    if (!item) continue

    if (item.type === 'radio') {
      const groupId = item.radioGroupId ?? item.id
      const group = [item]
      while (
        visibleItems[index + 1]?.type === 'radio' &&
        (visibleItems[index + 1]?.radioGroupId ??
          visibleItems[index + 1]?.id) === groupId
      ) {
        const next = visibleItems[index + 1]
        if (next) group.push(next)
        index += 1
      }
      rendered.push(
        <RadioItems
          key={`radio:${groupId}:${item.id}`}
          items={group}
          queueExecution={queueExecution}
        />
      )
      continue
    }

    if (item.type === 'separator') {
      rendered.push(<DropdownMenuSeparator key={item.id} />)
      continue
    }

    if (item.type === 'submenu' && enterSubmenu) {
      rendered.push(
        <DropdownMenuItem
          key={item.id}
          closeOnClick={false}
          disabled={!item.enabled}
          onClick={() => enterSubmenu(item)}
        >
          <ItemLabel item={item} />
          <ChevronRightIcon className="ms-auto size-3" />
        </DropdownMenuItem>
      )
      continue
    }
    if (item.type === 'submenu') {
      const hasVisibleChildren = item.children?.some((child) => child.visible)
      rendered.push(
        <DropdownMenuSub key={item.id}>
          <DropdownMenuSubTrigger
            disabled={!item.enabled || !hasVisibleChildren}
          >
            <ItemLabel item={item} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            data-menu-density="compact"
            className="application-menu app-no-drag"
          >
            <MenuTree
              items={item.children ?? []}
              queueExecution={queueExecution}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
      continue
    }

    if (item.type === 'checkbox') {
      rendered.push(
        <DropdownMenuCheckboxItem
          key={item.id}
          checked={item.checked ?? false}
          disabled={!item.enabled}
          closeOnClick
          onClick={(event) => queueExecution(item, event)}
        >
          <ItemLabel item={item} />
        </DropdownMenuCheckboxItem>
      )
      continue
    }

    rendered.push(
      <DropdownMenuItem
        key={item.id}
        disabled={!item.enabled}
        onClick={(event) => queueExecution(item, event)}
      >
        <ItemLabel item={item} />
      </DropdownMenuItem>
    )
  }

  return <>{rendered}</>
}

function ElectronMotrixMenuButton() {
  const { t } = useTranslation()
  const { snapshot, refresh, executeItem } = useApplicationMenu()
  const [open, setOpen] = useState(false)
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(width < 640px)').matches ?? false
  )
  const [stack, setStack] = useState<ApplicationMenuNode[]>([])
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !narrow || !stack.length) return
    const frame = requestAnimationFrame(() =>
      contentRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [open, narrow, stack])
  const selectedTaskId = useSelectedTask().task?.id ?? null
  const selectionAtOpen = useRef(captureTaskMenuIntent())
  const actionGeneration = useRef(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusCapturedForOpenRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const pendingExecution = useRef<ExecuteApplicationMenuItemRequest | null>(
    null
  )

  useEffect(() => {
    if (!window.matchMedia) return
    const small = window.matchMedia('(width < 640px)')
    const mobile = window.matchMedia('(width < 768px)')
    const cancel = () => {
      actionGeneration.current++
      pendingExecution.current = null
      restoreFocusRef.current = false
      setOpen(false)
      setStack([])
      setNarrow(small.matches)
    }
    const hide = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    small.addEventListener('change', cancel)
    mobile.addEventListener('change', cancel)
    const blur = (event: FocusEvent) => {
      if (event.target === window) cancel()
    }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hide)
    return () => {
      small.removeEventListener('change', cancel)
      mobile.removeEventListener('change', cancel)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [])

  const queueExecution: MenuTreeProps['queueExecution'] = (item, event) => {
    if (!snapshot) return
    pendingExecution.current = {
      itemId: item.id,
      revision: snapshot.revision,
      trigger: 'menu',
      selectedTaskGeneration: selectionAtOpen.current.generation,
      selectedTaskId,
      modifiers: modifiersFromEvent(event),
    }
  }

  const executeAfterFocusRestore = (open: boolean) => {
    if (open) return
    const request = pendingExecution.current
    pendingExecution.current = null
    // Keep the Escape decision available until FloatingFocusManager unmounts;
    // its return-focus cleanup runs after this completion callback.
    if (!request) return
    const current = actionGeneration.current
    restoreFocusRef.current = false
    requestAnimationFrame(() => {
      if (current !== actionGeneration.current) return
      const previousFocus = previousFocusRef.current
      const focusTarget =
        previousFocus?.isConnected &&
        !previousFocus.closest('[inert], [aria-hidden="true"]')
          ? previousFocus
          : triggerRef.current
      focusTarget?.focus({ preventScroll: true })
      void executeItem(request)
    })
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(open, eventDetails) => {
        if (
          !open &&
          eventDetails.reason === 'escape-key' &&
          narrow &&
          stack.length
        ) {
          eventDetails.cancel()
          setStack((items) => items.slice(0, -1))
          return
        }
        setOpen(open)
        if (open) {
          actionGeneration.current++
          setStack([])
        }
        if (!open) {
          restoreFocusRef.current = shouldRestoreMenuFocus(eventDetails.reason)
          return
        }
        // Reopening during the close animation cancels the prior selection.
        pendingExecution.current = null
        restoreFocusRef.current = false
        if (!focusCapturedForOpenRef.current) {
          previousFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
        }
        focusCapturedForOpenRef.current = false
        selectionAtOpen.current = captureTaskMenuIntent()
        void refresh()
      }}
      onOpenChangeComplete={executeAfterFocusRestore}
    >
      <DropdownMenuTrigger
        data-slot="motrix-menu-trigger"
        ref={triggerRef}
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t('menu.app.title')}
            className="app-no-drag h-7 w-[72px] gap-1 bg-transparent ps-2 pe-1 hover:bg-accent"
            onPointerDownCapture={() => {
              previousFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null
              focusCapturedForOpenRef.current = true
            }}
            onKeyDownCapture={(event) => {
              if (
                event.key === 'Enter' ||
                event.key === ' ' ||
                event.key === 'ArrowDown' ||
                event.key === 'ArrowUp'
              ) {
                previousFocusRef.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null
                focusCapturedForOpenRef.current = true
              }
            }}
          />
        }
      >
        <MotrixLogo />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        onKeyDownCapture={(event) => {
          if (narrow && stack.length && event.key === 'ArrowLeft') {
            event.preventDefault()
            event.stopPropagation()
            setStack((items) => items.slice(0, -1))
          }
        }}
        data-menu-density="compact"
        className="application-menu app-no-drag"
        finalFocus={() => {
          if (!restoreFocusRef.current) return false
          return previousFocusRef.current?.isConnected
            ? previousFocusRef.current
            : true
        }}
      >
        {narrow && stack.length > 0 && (
          <>
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setStack((items) => items.slice(0, -1))}
            >
              <ArrowLeftIcon className="size-3" />
              {t('applicationMenu.back')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <MenuTree
          enterSubmenu={
            narrow ? (item) => setStack((items) => [...items, item]) : undefined
          }
          items={
            narrow && stack.length
              ? (stack.at(-1)?.children ?? [])
              : (snapshot?.items ?? [])
          }
          queueExecution={queueExecution}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Browser product actions and Electron native-menu IPC have separate adapters.
 */
export function MotrixMenuButton() {
  if (__MOTRIX_TARGET__ === 'web') return <WebMenuButton />
  const platform = rendererMenuPlatform()
  if (!platform) return null
  return <ElectronMotrixMenuButton />
}
