import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import '@renderer/lib/i18n'
import { EndpointList } from './endpoint-list'

interface FormShape {
  items: string[]
}

function Wrapper(props: { defaultValues: FormShape }) {
  const form = useForm<FormShape>({ defaultValues: props.defaultValues })
  return (
    <FormProvider {...form}>
      <EndpointList
        name="items"
        maxItems={3}
        itemSchema={z.string().min(1, 'required')}
        i18nKeys={{
          addButton: 'common.add',
          empty: 'settings.common.directoryEmpty',
        }}
        placeholder="host:port"
      />
    </FormProvider>
  )
}

describe('<EndpointList>', () => {
  it('renders empty state when list is empty', () => {
    render(<Wrapper defaultValues={{ items: [] }} />)
    expect(screen.getByText(/no directory selected/i)).toBeInTheDocument()
  })

  it('appends a valid entry on Add', async () => {
    render(<Wrapper defaultValues={{ items: [] }} />)
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('host:port')
    await user.type(input, 'foo:80')
    await user.click(screen.getByRole('button', { name: /add/i }))
    expect(screen.getByDisplayValue('foo:80')).toBeInTheDocument()
  })

  it('rejects empty entry with inline error', async () => {
    render(<Wrapper defaultValues={{ items: [] }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add/i }))
    expect(screen.getByText('required')).toBeInTheDocument()
  })

  it('hides Add row when maxItems reached', () => {
    render(<Wrapper defaultValues={{ items: ['a', 'b', 'c'] }} />)
    expect(screen.queryByPlaceholderText('host:port')).not.toBeInTheDocument()
  })

  it('removes an entry on × click', async () => {
    render(<Wrapper defaultValues={{ items: ['alpha', 'beta'] }} />)
    const user = userEvent.setup()
    const removeButtons = screen.getAllByRole('button', { name: /remove|×/i })
    await user.click(removeButtons[0])
    expect(screen.queryByDisplayValue('alpha')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('beta')).toBeInTheDocument()
  })
})
