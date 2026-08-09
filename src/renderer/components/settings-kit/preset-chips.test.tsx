import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import { PresetChips } from './preset-chips'

interface FormShape {
  count: number
}

function Wrapper(props: { initial: number }) {
  const form = useForm<FormShape>({ defaultValues: { count: props.initial } })
  return (
    <FormProvider {...form}>
      <div data-testid="value">{form.watch('count')}</div>
      <PresetChips
        name="count"
        options={[
          { label: '1', value: 1 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ]}
      />
    </FormProvider>
  )
}

describe('<PresetChips>', () => {
  it('renders one button per option', () => {
    render(<Wrapper initial={1} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('clicking a preset sets the bound field', async () => {
    render(<Wrapper initial={1} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '5' }))
    expect(screen.getByTestId('value')).toHaveTextContent('5')
  })
})
