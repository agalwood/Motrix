import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from './directory-picker'

const pickSaveDirMock = vi.fn()
vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ pickSaveDir: pickSaveDirMock }),
}))

interface FormShape {
  dir: string
}

function Wrapper(props: { initial: string; variant: 'compact' | 'input' }) {
  const form = useForm<FormShape>({ defaultValues: { dir: props.initial } })
  return (
    <FormProvider {...form}>
      <DirectoryPicker name="dir" variant={props.variant} />
      <div data-testid="value">{form.watch('dir')}</div>
    </FormProvider>
  )
}

describe('<DirectoryPicker>', () => {
  beforeEach(() => {
    pickSaveDirMock.mockReset()
  })

  it('input variant renders input + browse button', () => {
    render(<Wrapper initial="/x" variant="input" />)
    expect(screen.getByDisplayValue('/x')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument()
  })

  it('compact variant renders single button', () => {
    render(<Wrapper initial="/x" variant="compact" />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('/x').length).toBeGreaterThanOrEqual(1)
  })

  it('clicking browse calls pickSaveDir and updates field', async () => {
    pickSaveDirMock.mockResolvedValueOnce('/picked')
    render(<Wrapper initial="" variant="input" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(pickSaveDirMock).toHaveBeenCalled()
    expect(screen.getByTestId('value')).toHaveTextContent('/picked')
  })

  it('skips field update when picker returns null', async () => {
    pickSaveDirMock.mockResolvedValueOnce(null)
    render(<Wrapper initial="/keep" variant="input" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(screen.getByTestId('value')).toHaveTextContent('/keep')
  })

  it('ignores repeated clicks while a picker request is pending', async () => {
    let resolvePick!: (path: string | null) => void
    pickSaveDirMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePick = resolve
        })
    )
    render(<Wrapper initial="/current" variant="compact" />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    fireEvent.click(button)

    expect(pickSaveDirMock).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    resolvePick('/picked')
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByTestId('value')).toHaveTextContent('/picked')

    pickSaveDirMock.mockResolvedValueOnce(null)
    fireEvent.click(button)
    await waitFor(() => expect(pickSaveDirMock).toHaveBeenCalledTimes(2))
  })
})
