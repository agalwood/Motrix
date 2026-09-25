import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { useSettingsForm } from '@renderer/components/settings-kit/use-settings-form'
import { Form } from '@renderer/components/ui/form'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_GEOIP_SETTINGS,
  DEFAULT_TRACKER_SETTINGS,
} from '@shared/schemas'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { BtPeerGeoSection } from './bt-peer-geo-section'
import { bitTorrentFormSchema } from './settings-form-schemas'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(async () => ({ isDownloading: false })),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
function Harness({ enabled = false }: { enabled?: boolean }) {
  const form = useSettingsForm(
    bitTorrentFormSchema,
    bitTorrentFormSchema.parse({
      engine: DEFAULT_ENGINE_SETTINGS,
      app: DEFAULT_APP_SETTINGS,
      tracker: DEFAULT_TRACKER_SETTINGS,
      geoip: { ...DEFAULT_GEOIP_SETTINGS, enabled },
    })
  )
  return (
    <Form {...form}>
      <BtPeerGeoSection form={form} ready />
    </Form>
  )
}
it('keeps preference changes in the outer draft and blocks Update until saved', async () => {
  render(<Harness />)
  fireEvent.click(
    screen.getByRole('switch', { name: 'Show country or region' })
  )
  expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled()
  expect(
    screen.getByText('Save changes before updating location data.')
  ).toBeVisible()
  expect(transport.invoke).not.toHaveBeenCalledWith(
    Commands.UpdateSettings,
    expect.anything()
  )
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('combobox', { name: 'Location data source' })
  )
  await user.click(screen.getByRole('option', { name: 'Custom URL' }))
  expect(
    screen.getByRole('textbox', { name: 'Custom download URL' })
  ).toBeEnabled()
})
it('runs a database update using saved settings without saving the form', async () => {
  render(<Harness enabled />)
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
  await waitFor(() =>
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateGeoIPDatabase)
  )
  expect(transport.invoke).not.toHaveBeenCalledWith(
    Commands.UpdateSettings,
    expect.anything()
  )
})
it('does not offer a database update when locations are disabled', () => {
  render(<Harness />)
  expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled()
})
