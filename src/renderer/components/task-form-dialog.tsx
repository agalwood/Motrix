import {
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { WindowChromeCaptionIcon } from '@renderer/components/window-chrome/window-chrome'
import {
  ADD_TASK_MAX_HEIGHT,
  TASK_FORM_WIDTH,
} from '@shared/constants/add-task'
import type { ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'

export function TaskFormDialog({
  contentRef,
  height,
  title,
  busy,
  children,
}: {
  contentRef: Ref<HTMLDivElement>
  height: number
  title: string
  busy: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <DialogContent
      ref={contentRef}
      showCloseButton={false}
      overlayClassName="transition-opacity duration-150 data-open:animate-none data-closed:animate-none data-starting-style:opacity-0 data-ending-style:opacity-0"
      className="flex w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{
        height,
        maxWidth: TASK_FORM_WIDTH,
        maxHeight: `min(${ADD_TASK_MAX_HEIGHT}px, calc(100vh - 2rem))`,
      }}
    >
      <DialogHeader className="h-10 shrink-0 justify-center px-4 pe-14">
        <DialogTitle className="pt-[14px] text-[13px] font-semibold">
          {title}
        </DialogTitle>
      </DialogHeader>
      {children}
      <DialogClose
        disabled={busy}
        aria-label={t('chrome.close')}
        className="app-no-drag absolute top-3.5 end-3.5 flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-foreground outline-none transition-colors [&>svg]:opacity-65 hover:bg-accent hover:text-accent-foreground hover:[&>svg]:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <WindowChromeCaptionIcon name="close" />
      </DialogClose>
    </DialogContent>
  )
}
