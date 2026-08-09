export function matchesAccelerator(
  e: KeyboardEvent,
  accelerator: string
): boolean {
  const parts = accelerator.split('+').map((p) => p.trim())
  const key = parts.pop()?.toLowerCase()
  if (!key) return false
  if (e.key.toLowerCase() !== key) return false

  let needCmdOrCtrl = false
  let needShift = false
  let needAlt = false
  for (const mod of parts) {
    const m = mod.toLowerCase()
    if (m === 'commandorcontrol' || m === 'cmdorctrl') needCmdOrCtrl = true
    else if (m === 'command' || m === 'cmd') needCmdOrCtrl = true
    else if (m === 'control' || m === 'ctrl') needCmdOrCtrl = true
    else if (m === 'shift') needShift = true
    else if (m === 'alt' || m === 'option') needAlt = true
  }

  const hasCmdOrCtrl = e.metaKey || e.ctrlKey
  if (needCmdOrCtrl !== hasCmdOrCtrl) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  return true
}

export function isTyping(target: EventTarget | null): boolean {
  if (!target || !(target as HTMLElement).tagName) return false
  const el = target as HTMLElement
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  return false
}
