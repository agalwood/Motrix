import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { TaskStatus } from '@shared/types/task'
import { textOperationManifest } from '@test-utils/plugin-operation-fixture'
import { makeDownloadTask } from '@test-utils/task'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOperationDialog } from './operation-store'
import { OperationTaskMenuItems } from './operation-task-menu'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: (props: React.ComponentProps<'button'>) => (
    <button {...props} />
  ),
}))
const manifest = textOperationManifest()
const descriptor = {
  pluginId: manifest.id,
  definition: manifest.contributes.operations!.items[0],
}
const task = makeDownloadTask({
  id: 'selected',
  status: TaskStatus.Completed,
  fileCount: 1,
  finalPath: '/downloads/a.txt',
})
beforeEach(() => {
  vi.mocked(transport.invoke)
    .mockReset()
    .mockResolvedValue({ descriptors: [descriptor] })
  useOperationDialog.setState({ request: null })
})
afterEach(cleanup)
describe('declarative task operation entries', () => {
  it('loads only when opened and maps the selected task to the shared operation', async () => {
    const view = render(
      <OperationTaskMenuItems selected={[task]} open={false} />
    )
    expect(transport.invoke).not.toHaveBeenCalled()
    view.rerender(<OperationTaskMenuItems selected={[task]} open />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Deduplicate lines' })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.GetPluginOperations)
    expect(useOperationDialog.getState().request).toEqual({
      pluginId: manifest.id,
      operationId: descriptor.definition.id,
      taskIds: ['selected'],
    })
  })
  it('hides inapplicable selections and explains unavailable providers', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      descriptors: [{ ...descriptor, unavailable: 'disabled' }],
    })
    const view = render(<OperationTaskMenuItems selected={[task]} open />)
    expect(await screen.findByRole('button')).toBeDisabled()
    expect(screen.getByRole('button')).toHaveTextContent('Enable')
    view.rerender(
      <OperationTaskMenuItems
        selected={[{ ...task, status: TaskStatus.Downloading }]}
        open
      />
    )
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
  })
})
