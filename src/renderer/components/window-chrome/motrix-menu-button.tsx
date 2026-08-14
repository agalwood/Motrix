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
import { useApplicationMenu } from '@renderer/hooks/use-application-menu'
import { useSelectedTask } from '@renderer/hooks/use-selected-task'
import { transport } from '@renderer/lib/transport'
import type {
  ApplicationMenuNode,
  ExecuteApplicationMenuItemRequest,
} from '@shared/schemas/application-menu'
import { ChevronDown } from 'lucide-react'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useRef,
} from 'react'
import { useTranslation } from 'react-i18next'

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

const MOTRIX_LOGO_MASK = 'url("./mo-logo.svg")'

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

function MenuTree({ items, queueExecution }: MenuTreeProps) {
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

    if (item.type === 'submenu') {
      const hasVisibleChildren = item.children?.some((child) => child.visible)
      rendered.push(
        <DropdownMenuSub key={item.id}>
          <DropdownMenuSubTrigger
            disabled={!item.enabled || !hasVisibleChildren}
          >
            <ItemLabel item={item} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="app-no-drag">
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
  const selectedTaskId = useSelectedTask().task?.id ?? null
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusCapturedForOpenRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const pendingExecution = useRef<ExecuteApplicationMenuItemRequest | null>(
    null
  )

  const queueExecution: MenuTreeProps['queueExecution'] = (item, event) => {
    if (!snapshot) return
    pendingExecution.current = {
      itemId: item.id,
      revision: snapshot.revision,
      trigger: 'menu',
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
    const previousFocus = previousFocusRef.current
    const focusTarget = previousFocus?.isConnected
      ? previousFocus
      : triggerRef.current
    focusTarget?.focus({ preventScroll: true })
    restoreFocusRef.current = false
    void executeItem(request)
  }

  return (
    <DropdownMenu
      onOpenChange={(open, eventDetails) => {
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
            className="app-no-drag h-7 w-[72px] gap-1 bg-transparent pl-2 pr-1 hover:bg-accent"
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
        <span
          aria-hidden="true"
          data-slot="motrix-menu-logo"
          className="h-2.5 w-11 shrink-0 bg-foreground"
          style={{
            maskImage: MOTRIX_LOGO_MASK,
            maskPosition: 'center',
            maskRepeat: 'no-repeat',
            maskSize: 'contain',
            WebkitMaskImage: MOTRIX_LOGO_MASK,
            WebkitMaskPosition: 'center',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskSize: 'contain',
          }}
        />
        <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="app-no-drag min-w-56"
        finalFocus={() => {
          if (!restoreFocusRef.current) return false
          return previousFocusRef.current?.isConnected
            ? previousFocusRef.current
            : true
        }}
      >
        <MenuTree
          items={snapshot?.items ?? []}
          queueExecution={queueExecution}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Platform gate deliberately lives outside the hook-owning component: web and
 * macOS use their native menus and never subscribe to the renderer menu IPC.
 */
export function MotrixMenuButton() {
  const platform = rendererMenuPlatform()
  if (!platform) return null
  return <ElectronMotrixMenuButton />
}
