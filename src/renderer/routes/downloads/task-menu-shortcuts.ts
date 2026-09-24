import { CommandIds } from '@shared/commands-catalog'
import { DEFAULT_KEYBINDINGS } from '@shared/keybindings-catalog'

export interface TaskMenuShortcut {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  label: string
  aria: string
}

function shortcut(accelerator: string, macOS: boolean): TaskMenuShortcut {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const primary = parts.includes('CommandOrControl')
  const metaKey = parts.includes('Command') || (primary && macOS)
  const ctrlKey = parts.includes('Control') || (primary && !macOS)
  const shiftKey = parts.includes('Shift')
  const altKey = parts.includes('Alt')
  const modifiers = [
    ctrlKey && ['Ctrl', '⌃', 'Control'],
    altKey && ['Alt', '⌥', 'Alt'],
    shiftKey && ['Shift', '⇧', 'Shift'],
    metaKey && ['Meta', '⌘', 'Meta'],
  ].filter((part): part is string[] => Boolean(part))
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    label: [
      ...modifiers.map((part) => part[macOS ? 1 : 0]),
      macOS && key === 'Backspace' ? '⌫' : key,
    ].join(macOS ? '' : '+'),
    aria: [...modifiers.map((part) => part[2]), key].join('+'),
  }
}

export function taskMenuShortcuts(macOS: boolean, desktop: boolean) {
  const binding = DEFAULT_KEYBINDINGS.find(
    (entry) => entry.commandId === CommandIds.TaskNew
  )
  const newTask =
    binding &&
    (desktop
      ? binding.accelerator
      : binding.webAccelerator === undefined
        ? binding.accelerator
        : binding.webAccelerator)
  return {
    newTask: newTask ? shortcut(newTask, macOS) : null,
    inspector: shortcut('CommandOrControl+I', macOS),
    copyUrl: shortcut('CommandOrControl+C', macOS),
    remove: shortcut(macOS ? 'Command+Backspace' : 'Delete', macOS),
    removeWithFiles: shortcut(
      macOS ? 'Command+Shift+Backspace' : 'Shift+Delete',
      macOS
    ),
  }
}

export function matchesTaskMenuShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
  >,
  binding: TaskMenuShortcut
): boolean {
  return (
    event.key.toLowerCase() === binding.key.toLowerCase() &&
    event.metaKey === binding.metaKey &&
    event.ctrlKey === binding.ctrlKey &&
    event.shiftKey === binding.shiftKey &&
    event.altKey === binding.altKey
  )
}
