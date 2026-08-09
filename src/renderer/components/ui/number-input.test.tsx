import '@testing-library/jest-dom/vitest'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { NumberInput } from './number-input'

describe('<NumberInput>', () => {
  it('renders the initial value', () => {
    render(<NumberInput value={42} onChange={vi.fn()} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(42)
  })

  it('renders empty when value is undefined', () => {
    render(<NumberInput value={undefined} onChange={vi.fn()} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(null)
  })

  it('forwards id/aria props to the inner input, not the outer container', () => {
    render(
      <NumberInput
        value={1}
        onChange={vi.fn()}
        id="my-input"
        aria-describedby="my-desc"
        aria-invalid={true}
        aria-label="quantity"
      />
    )
    const input = screen.getByRole('spinbutton')
    expect(input).toHaveAttribute('id', 'my-input')
    expect(input).toHaveAttribute('aria-describedby', 'my-desc')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-label', 'quantity')
  })

  it('emits the parsed number when user types a valid value', async () => {
    // Render a stateful component that manages value
    function TestComponent() {
      const [value, setValue] = useState<number | undefined>(undefined)
      return <NumberInput value={value} onChange={setValue} />
    }
    const user = userEvent.setup()
    render(<TestComponent />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement

    await user.type(input, '42')

    expect(input).toHaveValue(42)
  })

  it('emits undefined when user clears the input and no fallback is set', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={5} onChange={onChange} />)
    await user.clear(screen.getByRole('spinbutton'))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('emits the fallback value when user clears and fallback is set', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={5} onChange={onChange} fallback={8080} />)
    await user.clear(screen.getByRole('spinbutton'))
    expect(onChange).toHaveBeenLastCalledWith(8080)
  })

  it('increments by step when + is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={5} onChange={onChange} step={2} />)
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith(7)
  })

  it('decrements by step when − is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={5} onChange={onChange} step={2} />)
    await user.click(screen.getByRole('button', { name: 'Decrement' }))
    expect(onChange).toHaveBeenLastCalledWith(3)
  })

  it('clamps + result to max', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={9} onChange={onChange} step={5} max={10} />)
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith(10)
  })

  it('clamps − result to min', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={1} onChange={onChange} step={5} min={0} />)
    await user.click(screen.getByRole('button', { name: 'Decrement' }))
    expect(onChange).toHaveBeenLastCalledWith(0)
  })

  it('disables + at max', () => {
    render(<NumberInput value={10} onChange={vi.fn()} max={10} />)
    expect(screen.getByRole('button', { name: 'Increment' })).toBeDisabled()
  })

  it('disables − at min', () => {
    render(<NumberInput value={0} onChange={vi.fn()} min={0} />)
    expect(screen.getByRole('button', { name: 'Decrement' })).toBeDisabled()
  })

  it('clicking + when value is undefined starts from fallback ?? min ?? 0', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <NumberInput
        value={undefined}
        onChange={onChange}
        fallback={100}
        step={1}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith(101)
  })

  it('clicking + when value and fallback are undefined starts from min', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <NumberInput value={undefined} onChange={onChange} min={5} step={1} />
    )
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith(6)
  })

  it('clicking + when value, fallback, min are all undefined starts from 0', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<NumberInput value={undefined} onChange={onChange} step={1} />)
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith(1)
  })

  it('disables all three controls when disabled is true', () => {
    render(<NumberInput value={5} onChange={vi.fn()} disabled />)
    expect(screen.getByRole('spinbutton')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decrement' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Increment' })).toBeDisabled()
  })
})

describe('<NumberInput> + react-hook-form', () => {
  interface FormShape {
    port: number
  }

  function Wrapper({ initial }: { initial: number }) {
    const form = useForm<FormShape>({ defaultValues: { port: initial } })
    return (
      <Form {...form}>
        <FormField
          control={form.control}
          name="port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Port</FormLabel>
              <FormControl>
                <NumberInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  min={1}
                  max={65535}
                  fallback={8080}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <div data-testid="value">{form.watch('port')}</div>
        <div data-testid="dirty">{form.formState.isDirty ? 'yes' : 'no'}</div>
      </Form>
    )
  }

  it('binds field.value to the input', () => {
    render(<Wrapper initial={1234} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(1234)
  })

  it('updates form state when + is clicked', async () => {
    const user = userEvent.setup()
    render(<Wrapper initial={1234} />)
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    expect(screen.getByTestId('value')).toHaveTextContent('1235')
    expect(screen.getByTestId('dirty')).toHaveTextContent('yes')
  })

  it('snaps to fallback when user clears the input', async () => {
    const user = userEvent.setup()
    render(<Wrapper initial={1234} />)
    await user.clear(screen.getByRole('spinbutton'))
    expect(screen.getByTestId('value')).toHaveTextContent('8080')
  })
})
