import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

interface AdaptiveDialogHeightOptions {
  collapsedHeight: number
  maxHeight: number
  open: boolean
  viewportPadding?: number
}

interface ClampDialogHeightOptions {
  collapsedHeight: number
  maxHeight: number
  naturalHeight: number
  viewportHeight: number
  viewportPadding: number
}

export function clampDialogHeight({
  collapsedHeight,
  maxHeight,
  naturalHeight,
  viewportHeight,
  viewportPadding,
}: ClampDialogHeightOptions): number {
  const availableHeight = Math.max(0, viewportHeight - viewportPadding)
  const upperBound = Math.min(maxHeight, availableHeight)
  const lowerBound = Math.min(collapsedHeight, upperBound)
  return Math.max(lowerBound, Math.min(upperBound, Math.floor(naturalHeight)))
}

export function useAdaptiveDialogHeight(
  dialogRef: RefObject<HTMLElement | null>,
  {
    collapsedHeight,
    maxHeight,
    open,
    viewportPadding = 32,
  }: AdaptiveDialogHeightOptions
): {
  height: number
  resetHeight: () => void
  scheduleMeasurement: () => void
} {
  const [height, setHeight] = useState(collapsedHeight)
  const frameRef = useRef(0)

  const measure = useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const header = dialog.querySelector<HTMLElement>(
      '[data-slot="dialog-header"]'
    )
    const body = dialog.querySelector<HTMLElement>(
      '[data-slot="add-task-form-body"]'
    )
    const footer = dialog.querySelector<HTMLElement>(
      '[data-slot="add-task-form-footer"]'
    )
    if (!header || !body || !footer) return

    const naturalHeight =
      header.getBoundingClientRect().height +
      body.scrollHeight +
      footer.getBoundingClientRect().height
    const nextHeight = clampDialogHeight({
      collapsedHeight,
      maxHeight,
      naturalHeight,
      viewportHeight: window.innerHeight,
      viewportPadding,
    })
    setHeight((current) => (current === nextHeight ? current : nextHeight))
  }, [collapsedHeight, dialogRef, maxHeight, viewportPadding])

  const scheduleMeasurement = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(measure)
  }, [measure])

  const resetHeight = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    setHeight(collapsedHeight)
  }, [collapsedHeight])

  useLayoutEffect(() => {
    if (!open) {
      setHeight(collapsedHeight)
      return
    }

    const dialog = dialogRef.current
    if (!dialog) return

    const resizeObserver = new ResizeObserver(scheduleMeasurement)
    const adaptiveContent = dialog.querySelector<HTMLElement>(
      '[data-adaptive-content]'
    )
    if (adaptiveContent) resizeObserver.observe(adaptiveContent)

    const mutationObserver = new MutationObserver(scheduleMeasurement)
    mutationObserver.observe(dialog, {
      attributes: true,
      attributeFilter: ['aria-expanded', 'data-state', 'hidden'],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', scheduleMeasurement)
    scheduleMeasurement()

    return () => {
      cancelAnimationFrame(frameRef.current)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', scheduleMeasurement)
    }
  }, [collapsedHeight, dialogRef, open, scheduleMeasurement])

  return { height, resetHeight, scheduleMeasurement }
}
