import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { DownloadModeSelect } from '@/components/download-mode-select'
import { i18n } from '@/shared/i18n'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

it('blocks confirmation on an unsupported browser while allowing an existing selection to be changed to direct', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <DownloadModeSelect
      id="download-mode"
      value="confirm"
      confirmationSupported={false}
      onChange={onChange}
    />
  )
  await user.click(screen.getByRole('combobox'))
  const confirm = await screen.findByRole('option', {
    name: i18n.t('options.downloadMode.confirm'),
  })
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  await user.click(
    await screen.findByRole('option', {
      name: i18n.t('options.downloadMode.direct'),
    })
  )
  expect(onChange).toHaveBeenCalledExactlyOnceWith('direct')
})

it('allows confirmation on a supported browser', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <DownloadModeSelect
      id="download-mode"
      value="direct"
      confirmationSupported
      onChange={onChange}
    />
  )
  await user.click(screen.getByRole('combobox'))
  await user.click(
    await screen.findByRole('option', {
      name: i18n.t('options.downloadMode.confirm'),
    })
  )
  expect(onChange).toHaveBeenCalledExactlyOnceWith('confirm')
})
