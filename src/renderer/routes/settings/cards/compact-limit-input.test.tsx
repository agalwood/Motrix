import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import { setByteUnitSystem } from '@renderer/hooks/use-byte-format'
import { i18n } from '@renderer/lib/i18n'
import type { SpeedLimitUnit } from '@shared/schemas/speed-limit-units'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompactLimitInput } from './compact-limit-input'

function Limit({
  initialValue = 0,
  onChange = vi.fn(),
  inherit = false,
}: {
  initialValue?: number
  onChange?: (value: number) => void
  inherit?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const [magnitude, setMagnitude] = useState<SpeedLimitUnit>('kilo')
  return (
    <CompactLimitInput
      aria-label="Download limit"
      value={value}
      magnitude={magnitude}
      onMagnitudeChange={setMagnitude}
      onValueChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      unitLabel="Download unit"
      zeroLabel={inherit ? 'Use standard' : 'Unlimited'}
      resetLabel={inherit ? 'Use standard limit' : 'Set unlimited'}
      zeroAction={inherit ? 'inherit' : 'unlimited'}
    />
  )
}

async function chooseUnit(
  user: ReturnType<typeof userEvent.setup>,
  unit: string
) {
  await user.click(screen.getByRole('combobox', { name: 'Download unit' }))
  await user.click(await screen.findByRole('option', { name: unit }))
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  setByteUnitSystem('decimal')
})

describe('CompactLimitInput', () => {
  it.each(['decimal', 'binary'] as const)(
    'preserves exact bytes through repeated %s unit switches',
    async (system) => {
      setByteUnitSystem(system)
      const bytes = 1_234_567_891
      const kilo = system === 'binary' ? 1024 : 1000
      const units = system === 'binary' ? ['KiB/s', 'MiB/s'] : ['KB/s', 'MB/s']
      const onChange = vi.fn()
      render(<Limit initialValue={bytes} onChange={onChange} />)
      const input = screen.getByRole('spinbutton')
      const user = userEvent.setup()
      for (let index = 0; index < 3; index++) {
        await chooseUnit(user, units[1])
        expect(input).toHaveValue(Number((bytes / kilo ** 2).toFixed(6)))
        expect(input).toHaveAttribute(
          'aria-valuetext',
          `${Number((bytes / kilo ** 2).toFixed(6))} ${units[1]}`
        )
        await chooseUnit(user, units[0])
        expect(input).toHaveValue(Number((bytes / kilo).toFixed(3)))
      }
      expect(onChange).not.toHaveBeenCalled()
    }
  )

  it.each(['decimal', 'binary'] as const)(
    'preselects a %s unit while unlimited and accepts fractional input',
    async (system) => {
      setByteUnitSystem(system)
      const mega = system === 'binary' ? 1024 ** 2 : 1000 ** 2
      const unit = system === 'binary' ? 'MiB/s' : 'MB/s'
      const onChange = vi.fn()
      render(<Limit onChange={onChange} />)
      const user = userEvent.setup()
      const input = screen.getByRole('spinbutton')
      await chooseUnit(user, unit)
      expect(input).toHaveValue(null)
      expect(input).toHaveAttribute('placeholder', 'Unlimited')
      expect(onChange).not.toHaveBeenCalled()
      await user.type(input, '1.1')
      expect(input).toHaveValue(1.1)
      expect(onChange).toHaveBeenLastCalledWith(Math.round(1.1 * mega))
      await user.tab()
      expect(input).toHaveValue(1.1)
      expect(screen.getByRole('combobox')).toHaveTextContent(unit)
      // A unit selection cannot feed the formatted number back into the model.
      onChange.mockClear()
      await chooseUnit(user, system === 'binary' ? 'KiB/s' : 'KB/s')
      await chooseUnit(user, unit)
      expect(onChange).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'keeps the selected unit after resetting (inherit=%s)',
    async (inherit) => {
      const onChange = vi.fn()
      render(
        <Limit initialValue={1_500_000} inherit={inherit} onChange={onChange} />
      )
      const user = userEvent.setup()
      await chooseUnit(user, 'MB/s')
      await user.click(
        screen.getByRole('button', {
          name: inherit ? 'Use standard limit' : 'Set unlimited',
        })
      )
      expect(onChange).toHaveBeenLastCalledWith(0)
      expect(screen.getByRole('combobox')).toHaveTextContent('MB/s')
      const input = screen.getByRole('spinbutton')
      expect(input).toHaveAttribute(
        'placeholder',
        inherit ? 'Use standard' : 'Unlimited'
      )
      await user.type(input, '2.5')
      expect(onChange).toHaveBeenLastCalledWith(2_500_000)
    }
  )

  it('keeps the magnitude and actual limit when the unit system changes', async () => {
    const onChange = vi.fn()
    render(<Limit initialValue={1_048_576} onChange={onChange} />)
    await chooseUnit(userEvent.setup(), 'MB/s')
    act(() => setByteUnitSystem('binary'))
    expect(screen.getByRole('spinbutton')).toHaveValue(1)
    expect(screen.getByRole('combobox')).toHaveTextContent('MiB/s')
    act(() => setByteUnitSystem('decimal'))
    expect(screen.getByRole('spinbutton')).toHaveValue(1.048576)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('steps in the selected unit without changing units at a magnitude boundary', async () => {
    const onChange = vi.fn()
    render(<Limit initialValue={999_000_000} onChange={onChange} />)
    await chooseUnit(userEvent.setup(), 'MB/s')
    const input = screen.getByRole('spinbutton')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue(1000)
    expect(screen.getByRole('combobox')).toHaveTextContent('MB/s')
    expect(onChange).toHaveBeenLastCalledWith(1_000_000_000)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(999_000_000)
  })

  it('does not turn tiny nonzero inputs into unlimited', async () => {
    const onChange = vi.fn()
    render(<Limit onChange={onChange} />)
    await chooseUnit(userEvent.setup(), 'MB/s')
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '0.0000001' } })
    expect(onChange).toHaveBeenLastCalledWith(1)
    fireEvent.change(input, { target: { value: '-0.0000001' } })
    expect(onChange).toHaveBeenLastCalledWith(-1)
  })
})
