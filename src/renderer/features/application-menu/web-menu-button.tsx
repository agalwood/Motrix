import './application-menu.css'
import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { MotrixLogo } from '@renderer/components/window-chrome/motrix-logo'
import { getTaskListSnapshot } from '@renderer/hooks/use-task-list'
import { operatorLogout, useOperatorSession } from '@renderer/lib/operator-auth'
import {
  type ParsedTorrentFile,
  readTorrentFile,
} from '@renderer/lib/parse-torrent-file'
import { transport } from '@renderer/lib/transport'
import {
  PRODUCT_MENU_ITEMS,
  PRODUCT_MENU_LINKS,
  type ProductMenuItem,
} from '@shared/application-menu-catalog'
import { type CommandId, CommandIds } from '@shared/commands-catalog'
import { Commands } from '@shared/protocol/commands'
import {
  type BulkTaskCommandResult,
  isStoppedTaskStatus,
} from '@shared/types/task-actions'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import {
  MenuConfirmation,
  type MenuConfirmationRequest,
} from './menu-confirmation'
import {
  captureTaskMenuIntent,
  focusDownloadsList,
  menuActionEnabled,
  menuContextSignature,
  startMenuConnection,
  subscribeMenuContext,
  type TaskMenuIntent,
  taskWritesAvailable,
} from './task-context'
import { useMenuCommand } from './use-menu-command'

function usableFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !element.closest('[inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
  )
}

export function WebMenuButton() {
  const { t } = useTranslation()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(width < 640px)').matches ?? false
  )
  const [level, setLevel] = useState<'task' | 'help' | null>(null)
  const [intent, setIntent] = useState<TaskMenuIntent>()
  const [confirmation, setConfirmation] =
    useState<MenuConfirmationRequest | null>(null)
  const canLogout = useOperatorSession((s) => s.status?.canLogout === true)
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const source = useRef<HTMLElement | null>(null)
  const pending = useRef<CommandId | 'logout' | null>(null)
  const generation = useRef(0)
  const closingComplete = useRef(true)
  const restore = useRef(false)
  const picker = useRef<{
    generation: number
    epoch: number
    route: string
    revision: number
    files?: ParsedTorrentFile[]
  } | null>(null)
  const route = `${location.pathname}${location.search}`
  const routeRef = useRef(route)
  routeRef.current = route
  useSyncExternalStore(subscribeMenuContext, () => menuContextSignature(intent))
  useEffect(startMenuConnection, [])
  useEffect(() => {
    if (!open || !narrow || !level) return
    const frame = requestAnimationFrame(() =>
      content.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [open, narrow, level])
  useEffect(() => {
    const element = input.current
    const cancel = () => {
      picker.current = null
    }
    element?.addEventListener('cancel', cancel)
    return () => element?.removeEventListener('cancel', cancel)
  }, [])

  const cancelPending = useCallback(() => {
    generation.current++
    pending.current = null
    picker.current = null
    restore.current = false
    setOpen(false)
  }, [])
  useEffect(() => {
    routeRef.current = route
    cancelPending()
  }, [route, cancelPending])
  useEffect(() => {
    if (!window.matchMedia) return
    const small = window.matchMedia('(width < 640px)')
    const mobile = window.matchMedia('(width < 768px)')
    const resize = () => {
      cancelPending()
      setNarrow(small.matches)
      setLevel(null)
    }
    const blur = (event: FocusEvent) => {
      if (event.target === window && !picker.current) cancelPending()
    }
    const hide = () => {
      if (document.visibilityState === 'hidden') cancelPending()
    }
    small.addEventListener('change', resize)
    mobile.addEventListener('change', resize)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hide)
    return () => {
      small.removeEventListener('change', resize)
      mobile.removeEventListener('change', resize)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [cancelPending])

  const restoreSource = () => {
    if (usableFocus(source.current))
      source.current.focus({ preventScroll: true })
    else if (document.querySelector('[data-downloads-grid]'))
      focusDownloadsList()
    else trigger.current?.focus({ preventScroll: true })
  }
  const confirmClear = () => {
    const ids = getTaskListSnapshot()
      .tasks.filter((task) => isStoppedTaskStatus(task.status))
      .map((task) => task.id)
    if (!ids.length) return
    setConfirmation({
      kind: 'clear',
      count: ids.length,
      run: async () => {
        if (!taskWritesAvailable()) throw new Error('Task snapshot unavailable')
        const result = (await transport.invoke(
          Commands.ClearStoppedTasks,
          ids
        )) as BulkTaskCommandResult
        if (result.failed.length)
          throw new Error('Some task records were retained')
      },
    })
  }
  const execute = useMenuCommand(intent, confirmClear)
  const deliverFiles = () => {
    const request = picker.current
    if (!request?.files || !closingComplete.current) return
    requestAnimationFrame(() => {
      if (picker.current !== request) return
      picker.current = null
      const dialog = useAddTaskDialogStore.getState()
      if (
        request.generation !== generation.current ||
        request.epoch !== useOperatorSession.getState().epoch ||
        request.route !== routeRef.current ||
        request.revision !== dialog.revision ||
        dialog.open ||
        useOperatorSession.getState().state !== 'authenticated'
      )
        return
      restoreSource()
      restore.current = false
      dialog.openWith({ tab: 'torrent' }, request.files)
    })
  }
  const chooseFiles = () => {
    picker.current = {
      generation: generation.current,
      epoch: useOperatorSession.getState().epoch,
      route: routeRef.current,
      revision: useAddTaskDialogStore.getState().revision,
    }
    // Must run in the menu item's trusted activation, before the close animation.
    input.current?.click()
  }
  const queue = (id: CommandId) => {
    if (!menuActionEnabled(id, intent)) return
    if (id === CommandIds.TaskOpenFile) chooseFiles()
    else pending.current = id
  }
  const renderItems = (section: ProductMenuItem['section']): ReactNode[] => {
    const result: ReactNode[] = []
    let group = ''
    for (const item of PRODUCT_MENU_ITEMS.filter(
      (item) => item.section === section
    )) {
      if (group && group !== item.group && section !== 'app')
        result.push(<DropdownMenuSeparator key={`separator-${item.group}`} />)
      group = item.group
      const href = PRODUCT_MENU_LINKS[item.commandId]
      result.push(
        <DropdownMenuItem
          key={item.id}
          id={item.id}
          disabled={!menuActionEnabled(item.commandId, intent)}
          render={
            href ? (
              <a
                aria-label={t(item.title)}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t(item.title)}
              </a>
            ) : undefined
          }
          onClick={() => {
            if (!href) queue(item.commandId)
          }}
        >
          {t(item.title)}
        </DropdownMenuItem>
      )
    }
    return result
  }
  const submenu = (section: 'task' | 'help') =>
    narrow ? (
      <DropdownMenuItem
        key={section}
        closeOnClick={false}
        onClick={() => setLevel(section)}
      >
        {t(`menu.${section}.title`)}
        <ChevronRight className="ms-auto size-3" />
      </DropdownMenuItem>
    ) : (
      <DropdownMenuSub key={section}>
        <DropdownMenuSubTrigger>
          {t(`menu.${section}.title`)}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          data-menu-density="compact"
          className="application-menu app-no-drag"
        >
          {renderItems(section)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next, details) => {
          if (!next && details.reason === 'escape-key' && narrow && level) {
            details.cancel()
            setLevel(null)
            return
          }
          if (next) {
            generation.current++
            pending.current = null
            picker.current = null
            closingComplete.current = false
            restore.current = false
            setIntent(captureTaskMenuIntent())
            setLevel(null)
          } else
            restore.current =
              details.reason === 'escape-key' || details.reason === 'item-press'
          setOpen(next)
        }}
        onOpenChangeComplete={(next) => {
          if (next) return
          closingComplete.current = true
          const command = pending.current
          pending.current = null
          if (command) {
            const current = generation.current
            restore.current = false
            // Let the closing menu's focus manager unmount before mounting a dialog.
            requestAnimationFrame(() => {
              if (generation.current !== current) return
              restoreSource()
              if (command === 'logout')
                setConfirmation({ kind: 'logout', run: operatorLogout })
              else void execute(command)
            })
          }
          deliverFiles()
        }}
      >
        <DropdownMenuTrigger
          ref={trigger}
          data-slot="motrix-menu-trigger"
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={t('menu.app.title')}
              className="app-no-drag h-7 w-[72px] gap-1 bg-transparent pl-2 pr-1 hover:bg-accent"
              onPointerDownCapture={() => {
                source.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null
              }}
              onKeyDownCapture={() => {
                source.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null
              }}
            />
          }
        >
          <MotrixLogo />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={content}
          align="start"
          data-menu-density="compact"
          className="application-menu app-no-drag"
          finalFocus={() =>
            restore.current && usableFocus(source.current)
              ? source.current
              : restore.current
                ? trigger.current
                : false
          }
          onKeyDownCapture={(event) => {
            if (level && event.key === 'ArrowLeft') {
              event.preventDefault()
              event.stopPropagation()
              setLevel(null)
            }
          }}
        >
          {level ? (
            <>
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => setLevel(null)}
              >
                <ArrowLeft className="size-3" />
                {t('applicationMenu.back')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {renderItems(level)}
            </>
          ) : (
            <>
              {renderItems('app')}
              <DropdownMenuSeparator />
              {submenu('task')}
              {submenu('help')}
              {canLogout && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      pending.current = 'logout'
                    }}
                  >
                    {t('applicationMenu.signOut')}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={input}
        type="file"
        accept=".torrent"
        multiple
        className="hidden"
        aria-label={t('menu.task.openFile')}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          const request = picker.current
          if (!request || !files.length) {
            picker.current = null
            return
          }
          void (async () => {
            const parsed: ParsedTorrentFile[] = []
            for (const file of files) {
              if (picker.current !== request) return
              try {
                parsed.push(await readTorrentFile(file))
              } catch {
                toast.add({ title: t('task.add.parseFailed'), type: 'error' })
              }
            }
            if (picker.current !== request) return
            if (!parsed.length) {
              picker.current = null
              return
            }
            request.files = parsed
            deliverFiles()
          })()
        }}
      />
      <MenuConfirmation
        request={confirmation}
        close={() => setConfirmation(null)}
      />
    </>
  )
}
