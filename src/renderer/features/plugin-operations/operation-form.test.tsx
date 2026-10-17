import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type {
  OperationDescriptor,
  OperationDraft,
  OperationJob,
} from '@shared/schemas/plugin-operations'
import { textOperationManifest } from '@test-utils/plugin-operation-fixture'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OperationForm from './operation-form'
import { operationSessionKey, useOperationSessions } from './operation-store'

const { listeners, connectionListeners, transportMock } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const connectionListeners = new Set<(event: { state: string }) => void>()
  return {
    listeners,
    connectionListeners,
    transportMock: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: Listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
      }),
      off: vi.fn((channel: string, listener: Listener) => {
        listeners.get(channel)?.delete(listener)
      }),
      onConnectionChange: (listener: (event: { state: string }) => void) => {
        connectionListeners.add(listener)
        return () => connectionListeners.delete(listener)
      },
    },
  }
})
vi.mock('@renderer/lib/transport', () => ({ transport: transportMock }))
function emit(channel: string, payload?: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}
const invoke = vi.mocked(transport.invoke)
const manifest = textOperationManifest()
const request = {
  pluginId: manifest.id,
  operationId: `${manifest.id}.deduplicate`,
}
const descriptor = {
  pluginId: manifest.id,
  pluginName: manifest.name,
  pluginVersion: manifest.version,
  descriptorRevision: 'a'.repeat(64),
  definition: manifest.contributes.operations?.items[0],
  argsSchema: manifest.contributes.commands?.[0].argsSchema,
  resultSchema: manifest.contributes.commands?.[0].resultSchema,
} as OperationDescriptor
const input = '00000000-0000-4000-8000-000000000002'
const output = '00000000-0000-4000-8000-000000000003'
const draft: OperationDraft = {
  id: '00000000-0000-4000-8000-000000000001',
  descriptor,
  args: { input, output, ignoreCase: false },
  files: {
    input: { ref: input, name: 'input.txt', location: '/files/input.txt' },
    output: { ref: output, name: 'output.txt', location: '/files/output.txt' },
  },
  expiresAt: Date.now() + 600_000,
}
const job: OperationJob = {
  id: '00000000-0000-4000-8000-000000000004',
  pluginId: manifest.id,
  operationId: request.operationId,
  pluginName: manifest.name,
  title: 'Deduplicate lines',
  status: 'running',
  percent: 0,
  sequence: 0,
  createdAt: 1,
  updatedAt: 1,
  outputs: [],
}
const mount = () =>
  render(
    <PlatformServicesProvider services={electronServices}>
      <OperationForm {...request} />
    </PlatformServicesProvider>
  )
function formatDrafts() {
  const custom = structuredClone(descriptor)
  custom.argsSchema.properties!.format = {
    type: 'string',
    enum: ['txt', 'md'],
    default: 'txt',
  }
  custom.argsSchema.required!.push('format')
  custom.definition.fields.push({
    field: 'format',
    label: 'Output format',
    widget: 'segmented',
  })
  Object.assign(custom.definition.files!.output, { extensionFrom: 'format' })
  custom.definition.ui!.layout = {
    type: 'grid',
    columns: 2,
    children: [
      { type: 'field', field: 'input' },
      { type: 'field', field: 'ignoreCase' },
      { type: 'field', field: 'output', span: 2, accessory: 'format' },
    ],
  }
  const current: OperationDraft = {
    ...structuredClone(draft),
    descriptor: custom,
    args: { ...draft.args, format: 'txt' },
  }
  const changed: OperationDraft = {
    ...current,
    args: { input, ignoreCase: false, format: 'md' },
    files: { input: current.files.input },
    suggestions: { output: '/files/output.md' },
  }
  const base = invoke.getMockImplementation()
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === Commands.GetPluginOperations)
      return { descriptors: [custom], jobs: [] }
    if (channel === Commands.PreparePluginOperation) return current
    if (channel === Commands.UpdatePluginOperationDraft) return changed
    return base?.(channel, ...args)
  })
  return { current, changed }
}
describe('declarative operation form', () => {
  beforeEach(() => {
    useOperationSessions.setState({ sessions: {} })
    invoke.mockReset().mockImplementation(async (channel) => {
      if (channel === Commands.GetPluginOperations)
        return { descriptors: [descriptor], jobs: [] }
      if (channel === Commands.PreparePluginOperation) return draft
      if (
        channel === Commands.StartPluginOperation ||
        channel === Commands.GetPluginOperationJob
      )
        return job
      if (channel === Commands.CancelPluginOperation)
        return { ...job, status: 'cancelled', error: 'pluginOperations.failed' }
      return null
    })
  })
  afterEach(async () => {
    cleanup()
    await applyRendererLocale('en-US')
  })
  it('shows a skeleton while loading and resumes the host draft after repeated document reloads', async () => {
    let loaded!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve
        })
    )
    const view = mount()
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(
      view.container.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument()
    await act(async () => loaded({ descriptors: [descriptor], jobs: [] }))
    await screen.findByRole('button', { name: 'Input file' })
    expect(screen.queryByText('*', { exact: true })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Output file' })
    ).toHaveAccessibleDescription('Required field')
    view.unmount()
    for (let index = 0; index < 6; index++) {
      useOperationSessions.setState({ sessions: {} })
      const reload = mount()
      await screen.findByRole('button', { name: 'Input file' })
      expect(invoke).toHaveBeenLastCalledWith(Commands.PreparePluginOperation, {
        ...request,
        taskIds: [],
        resume: true,
      })
      reload.unmount()
    }
  })
  it('submits references once, preserves false, and cancels through the host', async () => {
    mount()
    const run = await screen.findByRole('button', { name: 'Run operation' })
    fireEvent.click(run)
    fireEvent.click(run)
    await screen.findByText('Running')
    const calls = invoke.mock.calls.filter(
      ([channel]) => channel === Commands.StartPluginOperation
    )
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({
      args: { input, output, ignoreCase: false },
      descriptorRevision: descriptor.descriptorRevision,
    })
    expect(JSON.stringify(calls[0][1])).not.toContain('/files/')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('Cancelled')
    expect(
      screen.queryByText(
        'The operation failed. See the plugin log for details.'
      )
    ).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(Commands.CancelPluginOperation, job.id)
  })
  it('recovers a running job after reload without issuing a new start', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.GetPluginOperations
        ? { descriptors: [descriptor], jobs: [job] }
        : base?.(channel, ...args)
    )
    const view = mount()
    await screen.findByText('Running')
    view.unmount()
    mount()
    await screen.findByText('Running')
    expect(
      screen.queryByRole('switch', { name: 'Ignore case' })
    ).not.toBeInTheDocument()
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.StartPluginOperation
      )
    ).toBe(false)
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.PreparePluginOperation
      )
    ).toBe(false)
  })
  it.each(['succeeded', 'cancelled', 'failed'] as const)(
    'opens a fresh form instead of restoring a %s journal after restart',
    async (status) => {
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) =>
        channel === Commands.GetPluginOperations
          ? { descriptors: [descriptor], jobs: [{ ...job, status }] }
          : base?.(channel, ...args)
      )
      mount()
      expect(
        await screen.findByRole('button', { name: 'Input file' })
      ).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull()
      expect(invoke).toHaveBeenCalledWith(Commands.PreparePluginOperation, {
        ...request,
        taskIds: [],
        resume: true,
      })
      expect(
        invoke.mock.calls.some(
          ([channel]) => channel === Commands.StartPluginOperation
        )
      ).toBe(false)
    }
  )
  it('preserves interrupted cleanup warnings without restarting the job', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.GetPluginOperations
        ? {
            descriptors: [descriptor],
            jobs: [{ ...job, status: 'interrupted', cleanupWarning: true }],
          }
        : base?.(channel, ...args)
    )
    mount()
    await screen.findByText('Interrupted')
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.PreparePluginOperation
      )
    ).toBe(false)
  })
  it.each(['draft', 'completed'] as const)(
    'discards a cached %s when a plugin update changes the descriptor revision',
    async (kind) => {
      useOperationSessions.getState().save(operationSessionKey(request), {
        descriptor,
        draft,
        values: { ...draft.args, ignoreCase: true },
        ...(kind === 'completed'
          ? { job: { ...job, status: 'succeeded' as const } }
          : {}),
      })
      const updated = { ...descriptor, descriptorRevision: 'b'.repeat(64) }
      const fresh = {
        ...draft,
        descriptor: updated,
        args: { ignoreCase: false },
        files: {},
      }
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) => {
        if (channel === Commands.GetPluginOperations)
          return {
            descriptors: [updated],
            jobs: [{ ...job, status: 'succeeded' }],
          }
        if (channel === Commands.PreparePluginOperation) return fresh
        return base?.(channel, ...args)
      })
      mount()
      expect(
        await screen.findByRole('button', { name: 'Input file' })
      ).toBeEnabled()
      expect(screen.queryByText('input.txt')).toBeNull()
      expect(screen.queryByText('output.txt')).toBeNull()
      expect(screen.queryByText('Completed')).toBeNull()
      expect(
        screen.getByRole('switch', { name: 'Ignore case' })
      ).not.toBeChecked()
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeDisabled()
    }
  )
  it.each(['install', 'reconnect'] as const)(
    'refreshes an open form after %s without an application reload',
    async (trigger) => {
      let current = descriptor
      let currentDraft = draft
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) => {
        if (channel === Commands.GetPluginOperations)
          return { descriptors: [current], jobs: [] }
        if (channel === Commands.PreparePluginOperation) return currentDraft
        if (channel === Commands.StartPluginOperation)
          return { ...job, status: 'succeeded' }
        return base?.(channel, ...args)
      })
      const view = mount()
      fireEvent.click(
        await screen.findByRole('button', { name: 'Run operation' })
      )
      await screen.findByText('Completed')
      current = structuredClone(descriptor)
      current.descriptorRevision = 'c'.repeat(64)
      current.definition.title = 'Updated text operation'
      currentDraft = {
        ...draft,
        descriptor: current,
        args: { ignoreCase: false },
        files: {},
      }
      await act(async () => {
        if (trigger === 'install')
          emit(Events.PluginInstalled, { pluginId: request.pluginId })
        else
          for (const listener of connectionListeners)
            listener({ state: 'connected' })
      })
      await screen.findByRole('heading', { name: 'Updated text operation' })
      expect(
        await screen.findByRole('button', { name: 'Input file' })
      ).toBeEnabled()
      expect(screen.queryByText('Completed')).toBeNull()
      expect(screen.queryByText('input.txt')).toBeNull()
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === Commands.PreparePluginOperation
        )
      ).toHaveLength(2)
      view.unmount()
      expect([...listeners.values()].every((value) => value.size === 0)).toBe(
        true
      )
      expect(connectionListeners.size).toBe(0)
    }
  )
  it('retains a completed result on ordinary page navigation in the same session', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.StartPluginOperation
        ? { ...job, status: 'succeeded' }
        : base?.(channel, ...args)
    )
    const view = mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Run operation' })
    )
    await screen.findByText('Completed')
    view.unmount()
    mount()
    await screen.findByText('Completed')
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.PreparePluginOperation
      )
    ).toHaveLength(1)
  })
  it('keeps a cancellation requested before host admission completes', async () => {
    let admit!: (value: OperationJob) => void
    const admission = new Promise<OperationJob>((resolve) => {
      admit = resolve
    })
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.StartPluginOperation
        ? admission
        : base?.(channel, ...args)
    )
    const onClose = vi.fn()
    const view = render(
      <PlatformServicesProvider services={electronServices}>
        <OperationForm {...request} onClose={onClose} />
      </PlatformServicesProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Run operation' })
    )
    await screen.findByText('Preparing files')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    // Closing the panel cannot lose an already requested cancellation.
    view.unmount()
    admit(job)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        Commands.CancelPluginOperation,
        job.id
      )
    )
    await waitFor(() =>
      expect(
        Object.values(useOperationSessions.getState().sessions)[0]?.job
      ).toMatchObject({ id: job.id, status: 'cancelled' })
    )
  })
  it('renders a non-media group with accessible controls', async () => {
    mount()
    expect(
      await screen.findByRole('button', { name: 'Matching options' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('switch', { name: 'Ignore case' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Matching options' }))
    expect(
      screen.getByRole('button', { name: 'Matching options' })
    ).toHaveAttribute('aria-expanded', 'false')
  })
  it('shows the full output, requests host reauthorization on repeat and retains options', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === Commands.StartPluginOperation)
        return {
          ...job,
          status: 'succeeded',
          outputs: [
            { id: output, name: 'output.txt', location: '/files/output.txt' },
          ],
        }
      return base?.(channel, ...args)
    })
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Run operation' })
    )
    expect(await screen.findByText('/files/output.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.PreparePluginOperation, {
        ...request,
        taskIds: [],
        repeatJobId: job.id,
      })
    )
  })
  it.each(['preserve-options', 'reset'] as const)(
    'clears previous file cards and task seeds when repeating with %s',
    async (repeat) => {
      const custom = structuredClone(descriptor)
      custom.definition.ui!.repeat = repeat
      const initial = {
        ...draft,
        descriptor: custom,
        args: { ...draft.args, ignoreCase: true },
      }
      const fresh = {
        ...initial,
        id: '00000000-0000-4000-8000-000000000005',
        args: { ignoreCase: repeat === 'preserve-options' },
        files: {},
        suggestions: {},
      }
      let prepared = false
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) => {
        if (channel === Commands.GetPluginOperations)
          return { descriptors: [custom], jobs: [] }
        if (channel === Commands.PreparePluginOperation) {
          if (prepared) return fresh
          prepared = true
          return initial
        }
        if (channel === Commands.StartPluginOperation)
          return { ...job, status: 'succeeded' }
        return base?.(channel, ...args)
      })
      render(
        <PlatformServicesProvider services={electronServices}>
          <OperationForm {...request} taskIds={['selected-task']} />
        </PlatformServicesProvider>
      )
      fireEvent.click(
        await screen.findByRole('button', { name: 'Run operation' })
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Run again' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Input file' })).toBeEnabled()
      )
      expect(screen.queryByText('input.txt')).not.toBeInTheDocument()
      expect(screen.queryByText('output.txt')).not.toBeInTheDocument()
      expect(screen.queryByText('/files/')).not.toBeInTheDocument()
      expect(screen.queryByText('Completed')).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeDisabled()
      expect(invoke).toHaveBeenLastCalledWith(Commands.PreparePluginOperation, {
        ...request,
        taskIds: [],
        ...(repeat === 'preserve-options' ? { repeatJobId: job.id } : {}),
      })
      const option = screen.getByRole('switch', { name: 'Ignore case' })
      if (repeat === 'preserve-options') expect(option).toBeChecked()
      else expect(option).not.toBeChecked()
    }
  )
  it('lets users select again after repeat authorization fails', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === Commands.StartPluginOperation)
        return { ...job, status: 'succeeded' }
      if (
        channel === Commands.PreparePluginOperation &&
        (args[0] as { repeatJobId?: string })?.repeatJobId
      )
        throw new Error('pluginOperations.fileChanged')
      return base?.(channel, ...args)
    })
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Run operation' })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('button', { name: 'Input file' })
    ).toBeEnabled()
    expect(
      invoke.mock.calls.filter(
        ([channel, arg]) =>
          channel === Commands.PreparePluginOperation &&
          (arg as { repeatJobId?: string })?.repeatJobId
      )
    ).toHaveLength(1)
  })
  it('composes an inline format control and confirms a changed output before starting', async () => {
    const { changed } = formatDrafts()
    const view = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'md' }))
    await screen.findByText('output.md')
    expect(
      view.container.querySelector('[data-operation-field="output"]')
    ).toHaveClass('sm:col-span-2')
    expect(
      screen.getByRole('group', { name: 'Output format' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run operation' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.PickPluginOperationFile, {
        draftId: draft.id,
        field: 'output',
        values: changed.args,
      })
    )
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.StartPluginOperation
      )
    ).toBe(false)
  })
  it('keeps file cards and format controls stable during a delayed format update', async () => {
    const { changed } = formatDrafts()
    let finish!: (value: OperationDraft) => void
    const update = new Promise<OperationDraft>((resolve) => {
      finish = resolve
    })
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.UpdatePluginOperationDraft
        ? update
        : base?.(channel, ...args)
    )
    const view = mount()
    const format = await screen.findByRole('button', { name: 'md' })
    const inputCard = screen.getByRole('button', { name: 'Input file' })
    const outputCard = screen.getByRole('button', { name: 'Output file' })
    format.focus()
    fireEvent.click(format)
    expect(format).toHaveAttribute('aria-pressed', 'true')
    expect(format).toHaveFocus()
    for (const control of [format, inputCard, outputCard])
      expect(control).toBeEnabled()
    const run = screen.getByRole('button', { name: 'Run operation' })
    expect(run).toBeDisabled()
    fireEvent.submit(run.closest('form')!)
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.StartPluginOperation
      )
    ).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: 'Ignore case' }))
    await act(async () => finish(changed))
    expect(screen.getByRole('button', { name: 'Input file' })).toBe(inputCard)
    expect(screen.getByRole('button', { name: 'Output file' })).toBe(outputCard)
    expect(screen.getByRole('button', { name: 'md' })).toBe(format)
    expect(format).toHaveFocus()
    expect(screen.getByRole('switch', { name: 'Ignore case' })).toBeChecked()
    expect(outputCard).toHaveTextContent('output.md')
    expect(view.container.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(run).toBeEnabled()
    expect(
      useOperationSessions.getState().sessions[operationSessionKey(request)]
        ?.values
    ).toEqual({ ...changed.args, ignoreCase: true })
  })
  it.each(['resolve', 'reject'] as const)(
    'serializes rapid format changes and retains the last confirmed draft on %s',
    async (result) => {
      const { changed } = formatDrafts()
      const requests: {
        resolve(value: OperationDraft): void
        reject(error: Error): void
      }[] = []
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) =>
        channel === Commands.UpdatePluginOperationDraft
          ? new Promise<OperationDraft>((resolve, reject) => {
              requests.push({ resolve, reject })
            })
          : base?.(channel, ...args)
      )
      mount()
      fireEvent.click(await screen.findByRole('button', { name: 'md' }))
      fireEvent.click(screen.getByRole('button', { name: 'txt' }))
      expect(requests).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'txt' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await act(async () => requests[0].resolve(changed))
      expect(requests).toHaveLength(2)
      expect(invoke).toHaveBeenLastCalledWith(
        Commands.UpdatePluginOperationDraft,
        {
          draftId: draft.id,
          values: expect.objectContaining({ format: 'txt' }),
        }
      )
      expect(screen.getByRole('button', { name: 'txt' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeDisabled()
      const finalDraft = {
        ...changed,
        args: { ...changed.args, format: 'txt' },
        suggestions: { output: '/files/output.txt' },
      }
      await act(async () => {
        if (result === 'resolve') requests[1].resolve(finalDraft)
        else requests[1].reject(new Error('pluginOperations.failed'))
      })
      const confirmed = result === 'resolve' ? finalDraft : changed
      expect(
        screen.getByRole('button', { name: String(confirmed.args.format) })
      ).toHaveAttribute('aria-pressed', 'true')
      expect(
        screen.getByRole('button', { name: 'Output file' })
      ).toHaveTextContent(`output.${confirmed.args.format}`)
      expect(
        useOperationSessions.getState().sessions[operationSessionKey(request)]
          ?.values
      ).toEqual(confirmed.args)
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeEnabled()
      if (result === 'reject')
        expect(screen.getByRole('alert')).toBeInTheDocument()
    }
  )
  it.each(['resolve', 'reject'] as const)(
    'waits for a format update before picking an output file on %s',
    async (result) => {
      const { current, changed } = formatDrafts()
      let finish!: (value: OperationDraft) => void
      let fail!: (error: Error) => void
      const update = new Promise<OperationDraft>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) =>
        channel === Commands.UpdatePluginOperationDraft
          ? update
          : base?.(channel, ...args)
      )
      mount()
      fireEvent.click(await screen.findByRole('button', { name: 'md' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Ignore case' }))
      fireEvent.click(screen.getByRole('button', { name: 'Output file' }))
      expect(
        invoke.mock.calls.some(
          ([channel]) => channel === Commands.PickPluginOperationFile
        )
      ).toBe(false)
      await act(async () => {
        if (result === 'resolve') finish(changed)
        else fail(new Error('pluginOperations.failed'))
      })
      if (result === 'resolve') {
        expect(invoke).toHaveBeenCalledWith(Commands.PickPluginOperationFile, {
          draftId: draft.id,
          field: 'output',
          values: { ...changed.args, ignoreCase: true },
        })
      } else {
        expect(
          invoke.mock.calls.some(
            ([channel]) => channel === Commands.PickPluginOperationFile
          )
        ).toBe(false)
        expect(screen.getByRole('button', { name: 'txt' })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        expect(
          screen.getByRole('button', { name: 'Output file' })
        ).toHaveTextContent('output.txt')
        expect(
          useOperationSessions.getState().sessions[operationSessionKey(request)]
            ?.values
        ).toEqual({ ...current.args, ignoreCase: true })
        expect(screen.getByRole('alert')).toBeInTheDocument()
      }
      expect(screen.getByRole('switch', { name: 'Ignore case' })).toBeChecked()
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeEnabled()
    }
  )
  it.each(['resolve', 'reject'] as const)(
    'reconciles an in-flight format update before reopening the form on %s',
    async (result) => {
      const { current, changed } = formatDrafts()
      let finish!: (value: OperationDraft) => void
      let fail!: (error: Error) => void
      const update = new Promise<OperationDraft>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const base = invoke.getMockImplementation()
      invoke.mockImplementation(async (channel, ...args) =>
        channel === Commands.UpdatePluginOperationDraft
          ? update
          : base?.(channel, ...args)
      )
      const first = mount()
      fireEvent.click(await screen.findByRole('button', { name: 'md' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Ignore case' }))
      first.unmount()
      const reopened = mount()
      await waitFor(() =>
        expect(
          invoke.mock.calls.filter(
            ([channel]) => channel === Commands.GetPluginOperations
          )
        ).toHaveLength(2)
      )
      expect(screen.queryByRole('button', { name: 'Run operation' })).toBeNull()
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
      await act(async () => {
        if (result === 'resolve') finish(changed)
        else fail(new Error('pluginOperations.fileChanged'))
      })
      const expected = result === 'resolve' ? changed : current
      expect(
        await screen.findByRole('button', { name: 'Output file' })
      ).toHaveTextContent(`output.${expected.args.format}`)
      expect(
        screen.getByRole('button', { name: String(expected.args.format) })
      ).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('switch', { name: 'Ignore case' })).toBeChecked()
      expect(
        screen.getByRole('button', { name: 'Run operation' })
      ).toBeEnabled()
      if (result === 'reject')
        expect(screen.getByRole('alert')).toHaveTextContent('changed')
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === Commands.PreparePluginOperation
        )
      ).toHaveLength(1)
      expect(
        useOperationSessions.getState().sessions[operationSessionKey(request)]
          ?.values
      ).toEqual({ ...expected.args, ignoreCase: true })
      reopened.unmount()
    }
  )
  it('does not open a queued file picker after the form closes', async () => {
    const { changed } = formatDrafts()
    let finish!: (value: OperationDraft) => void
    const update = new Promise<OperationDraft>((resolve) => {
      finish = resolve
    })
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.UpdatePluginOperationDraft
        ? update
        : base?.(channel, ...args)
    )
    const view = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Output file' }))
    view.unmount()
    await act(async () => finish(changed))
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.PickPluginOperationFile
      )
    ).toBe(false)
  })
  it('refreshes localized presentation without resetting dirty values, grants or a running job', async () => {
    const localized = structuredClone(descriptor)
    localized.definition.title = '文本去重'
    localized.definition.fields[0].label = '输入文件'
    localized.definition.fields.find(
      (field) => field.field === 'output'
    )!.label = '输出文件'
    localized.definition.fields.find(
      (field) => field.field === 'ignoreCase'
    )!.label = '忽略大小写'
    localized.definition.ui!.repeatLabel = '再次处理'
    let presentation = descriptor
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (channel, ...args) =>
      channel === Commands.GetPluginOperations
        ? { descriptors: [presentation], jobs: [] }
        : base?.(channel, ...args)
    )
    const view = mount()
    fireEvent.click(await screen.findByRole('switch', { name: 'Ignore case' }))
    presentation = localized
    await act(() => applyRendererLocale('zh-CN'))
    expect(
      await screen.findByRole('heading', { name: '文本去重' })
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '忽略大小写' })).toBeChecked()
    expect(screen.getByRole('button', { name: '输入文件' })).toHaveTextContent(
      'input.txt'
    )
    expect(screen.getAllByText('输出文件')).toHaveLength(1)
    view.unmount()
    mount()
    expect(
      await screen.findByRole('heading', { name: '文本去重' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '运行操作' }))
    await screen.findByText('正在运行')
    expect(invoke).toHaveBeenCalledWith(
      Commands.StartPluginOperation,
      expect.objectContaining({
        draftId: draft.id,
        args: { input, output, ignoreCase: true },
        descriptorRevision: descriptor.descriptorRevision,
      })
    )
    presentation = descriptor
    await act(() => applyRendererLocale('en-US'))
    await screen.findByRole('heading', { name: 'Deduplicate lines' })
    expect(screen.getByText('Running')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await screen.findByText('Cancelled')
    expect(invoke).toHaveBeenCalledWith(Commands.CancelPluginOperation, job.id)
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.PreparePluginOperation
      )
    ).toHaveLength(1)
  })
  it('opens only the operation-bound native picker', async () => {
    mount()
    const picker = await screen.findByRole('button', { name: 'Input file' })
    fireEvent.click(picker)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.PickPluginOperationFile, {
        draftId: draft.id,
        field: 'input',
        values: draft.args,
      })
    )
    expect(
      invoke.mock.calls.some(([channel]) => channel === Commands.PickFile)
    ).toBe(false)
  })
})
