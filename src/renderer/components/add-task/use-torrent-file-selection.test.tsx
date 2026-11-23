import '@testing-library/jest-dom/vitest'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  type AddTaskFormValues,
  addTaskFormSchema,
} from '@shared/schemas/add-task'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  FormProvider,
  type Resolver,
  useForm,
  useFormContext,
} from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { useTorrentFileSelection } from './use-torrent-file-selection'

function Controls() {
  const select = useTorrentFileSelection()
  const form = useFormContext<AddTaskFormValues>()
  const count = form.watch('selectedFiles')?.length
  return (
    <>
      <button type="button" onClick={() => select([0, 9])}>
        Choose
      </button>
      <button type="button" onClick={() => select([])}>
        Clear
      </button>
      <button type="submit">Submit</button>
      <output>{count}</output>
      <p>
        {form.getFieldState('selectedFiles', form.formState).error?.message}
      </p>
    </>
  )
}

describe('torrent file selection form updates', () => {
  it('does not reparse the manifest on checkbox changes and still validates at submission', async () => {
    const resolver = vi.fn(
      zodResolver(addTaskFormSchema) as Resolver<AddTaskFormValues>
    )
    const submitted = vi.fn()
    function Form() {
      const form = useForm<AddTaskFormValues>({
        resolver,
        defaultValues: {
          tab: 'torrent',
          source: 'file',
          base64: 'fixture',
          saveDir: '/downloads',
          selectedFiles: [0],
          torrentMeta: {
            name: 'large',
            infoHash: 'a'.repeat(40),
            totalSize: 10000,
            files: Array.from({ length: 10000 }, (_, index) => ({
              index,
              path: `${index}.bin`,
              size: 1,
              extension: '.bin',
            })),
          },
        },
      })
      return (
        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(submitted)}>
            <Controls />
          </form>
        </FormProvider>
      )
    }
    render(<Form />)
    fireEvent.click(screen.getByText('Choose'))
    expect(screen.getByRole('status')).toHaveTextContent('2')
    fireEvent.click(screen.getByText('Clear'))
    expect(resolver).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Submit'))
    expect(
      await screen.findByText('task.add.errors.noFilesSelected')
    ).toBeInTheDocument()
    expect(submitted).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Choose'))
    expect(
      screen.queryByText('task.add.errors.noFilesSelected')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Submit'))
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce())
    expect(submitted.mock.calls[0][0].selectedFiles).toEqual([0, 9])
    expect(resolver).toHaveBeenCalledTimes(2)
  })
})
