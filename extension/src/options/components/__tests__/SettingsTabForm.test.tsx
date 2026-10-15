import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { i18n } from '@/shared/i18n'

i18n.addResourceBundle(
  'en-US',
  'translation',
  {
    options: {
      common: {
        apply: 'Apply',
        cancel: 'Cancel',
        saved: 'Saved',
        saving: 'Saving',
      },
    },
  },
  true,
  true
)

function Harness({
  onSubmit,
}: {
  onSubmit: (v: { name: string }) => Promise<void>
}) {
  const form = useForm<{ name: string }>({ defaultValues: { name: 'a' } })
  return (
    <SettingsTabForm form={form} onSubmit={onSubmit}>
      <input aria-label="name" {...form.register('name')} />
    </SettingsTabForm>
  )
}

describe('SettingsTabForm', () => {
  it('disables Apply until a field is dirty, then submits and clears dirty', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<Harness onSubmit={onSubmit} />)
    const apply = screen.getByRole('button', { name: /apply|应用/i })
    expect((apply as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'b' } })
    expect((apply as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(apply)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'b' }))
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(true)
    )
  })

  it('cancel reverts edits', async () => {
    render(<Harness onSubmit={vi.fn(async () => {})} />)
    const input = screen.getByLabelText('name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: /cancel|取消/i }))
    await waitFor(() => expect(input.value).toBe('a'))
  })
})
