import { Events } from '@shared/protocol/events'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { act, renderHook } from '@testing-library/react'
import type { UseFormReturn } from 'react-hook-form'
import { useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExternalHydration } from './use-external-hydration'

const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    on: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = listeners[ch] ?? []
      listeners[ch].push(cb)
    }),
    off: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = (listeners[ch] ?? []).filter((l) => l !== cb)
    }),
  },
}))

function fire(channel: string, payload: unknown) {
  for (const l of listeners[channel] ?? []) l(payload)
}

describe('useExternalHydration', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k]
  })

  it('subscribes to the three IPC events when enabled', () => {
    const { result } = renderHook(() =>
      useForm({ defaultValues: { tab: 'links', urls: '', saveDir: '/d' } })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )
    expect(listeners[Events.MagnetFileSelection]).toHaveLength(1)
    expect(listeners[Events.ProtocolTorrentFile]).toHaveLength(1)
    expect(listeners[Events.SetAddTaskMode]).toHaveLength(1)
  })

  it('does not subscribe when disabled', () => {
    const { result } = renderHook(() =>
      useForm({ defaultValues: { tab: 'links', urls: '', saveDir: '/d' } })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        false
      )
    )
    expect(listeners[Events.MagnetFileSelection]).toBeUndefined()
  })

  it('resets form on MagnetFileSelection', () => {
    const { result } = renderHook(() =>
      useForm({ defaultValues: { tab: 'links', urls: '', saveDir: '/d' } })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      fire(Events.MagnetFileSelection, {
        taskId: 'm-pending',
        meta: {
          name: 't',
          infoHash: 'a'.repeat(40),
          totalSize: 0,
          files: [{ index: 0, path: 'a.mp4', size: 0, extension: '.mp4' }],
        },
        magnetUri: 'magnet:?xt=urn:btih:x',
        torrentBase64: 'dG9ycmVudA==',
        saveDir: '/m',
      })
    })

    const values = result.current.getValues() as Record<string, unknown>
    expect(values.tab).toBe('torrent')
    expect(values.source).toBe('magnet')
    expect(values.magnetUri).toBe('magnet:?xt=urn:btih:x')
    expect(values.base64).toBe('dG9ycmVudA==')
    // Plan B: existingTaskId is threaded through so the CreateTask
    // handler can swap the instance in place rather than creating a
    // duplicate row.
    expect(values.existingTaskId).toBe('m-pending')
  })

  it('SetAddTaskMode without saveDir preserves current saveDir', () => {
    const { result } = renderHook(() =>
      useForm({
        defaultValues: { tab: 'links', urls: '', saveDir: '/preset' },
      })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      fire(Events.SetAddTaskMode, { mode: 'links', url: 'https://a/b' })
    })

    const values = result.current.getValues() as Record<string, unknown>
    expect(values.saveDir).toBe('/preset')
    expect(values.urls).toBe('https://a/b')
  })

  it('SetAddTaskMode clears a stale per-task connection override', () => {
    const { result } = renderHook(() =>
      useForm({
        defaultValues: {
          tab: 'links',
          urls: '',
          saveDir: '/preset',
          split: 32,
        },
      })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      fire(Events.SetAddTaskMode, { mode: 'links', url: 'https://a/b' })
    })

    expect(
      (result.current.getValues() as Record<string, unknown>).split
    ).toBeUndefined()
  })

  it('notifies after SetAddTaskMode resets the form', () => {
    const { result } = renderHook(() =>
      useForm({
        defaultValues: {
          tab: 'links',
          urls: 'https://old.example/file.zip',
          saveDir: '/preset',
        },
      })
    )
    const onSetMode = vi.fn(() => {
      expect(result.current.getValues('urls')).toBe('')
    })
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true,
        onSetMode
      )
    )

    act(() => {
      fire(Events.SetAddTaskMode, { mode: 'links' })
    })

    expect(onSetMode).toHaveBeenCalledOnce()
  })

  it('SetAddTaskMode replaces dirty URL content from external opens', () => {
    const { result } = renderHook(() =>
      useForm({
        defaultValues: {
          tab: 'links',
          urls: 'https://old.example/file.zip',
          saveDir: '/preset',
        },
      })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      result.current.setValue(
        'urls' as never,
        'https://dirty.example' as never,
        {
          shouldDirty: true,
        }
      )
      fire(Events.SetAddTaskMode, {
        mode: 'links',
        url: 'magnet:?xt=urn:btih:abc',
      })
    })

    const values = result.current.getValues() as Record<string, unknown>
    expect(values.tab).toBe('links')
    expect(values.urls).toBe('magnet:?xt=urn:btih:abc')
    expect(values.saveDir).toBe('/preset')
  })

  it('SetAddTaskMode with explicit saveDir overrides the current value', () => {
    const { result } = renderHook(() =>
      useForm({
        defaultValues: { tab: 'links', urls: '', saveDir: '/preset' },
      })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      fire(Events.SetAddTaskMode, {
        mode: 'links',
        url: 'https://a/b',
        saveDir: '/override',
      })
    })

    expect(
      (result.current.getValues() as Record<string, unknown>).saveDir
    ).toBe('/override')
  })

  it('ignores invalid payloads silently', () => {
    const { result } = renderHook(() =>
      useForm({ defaultValues: { tab: 'links', urls: '', saveDir: '/d' } })
    )
    renderHook(() =>
      useExternalHydration(
        result.current as unknown as UseFormReturn<AddTaskFormValues>,
        true
      )
    )

    act(() => {
      fire(Events.MagnetFileSelection, { garbage: true })
    })

    expect((result.current.getValues() as Record<string, unknown>).tab).toBe(
      'links'
    )
  })
})
