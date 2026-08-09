import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginGuidance } from './plugin-guidance'

const openExternal = vi.fn()

function services(): PlatformServices {
  return {
    kind: 'electron',
    pickSaveDir: async () => null,
    closeHost: () => {},
    readClipboard: async () => '',
    openExternal,
    notify: () => {},
  }
}

function renderGuidance(hasUserManagedPlugin: boolean) {
  return render(
    <PlatformServicesProvider services={services()}>
      <TooltipProvider>
        <PluginGuidance hasUserManagedPlugin={hasUserManagedPlugin} />
      </TooltipProvider>
    </PlatformServicesProvider>
  )
}

describe('PluginGuidance', () => {
  it('renders the first-use guide as pure guidance without an Add action', () => {
    renderGuidance(false)

    expect(screen.getByTestId('plugin-first-use-guide')).toBeInTheDocument()
    expect(screen.getByText('Add plugins you trust')).toBeInTheDocument()
    expect(
      screen.getByText(/Install from a source you trust/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/Grant website access only/i)).toBeInTheDocument()

    // The page header already owns the persistent "Add plugin" entry point;
    // the guide must not duplicate it.
    expect(screen.queryByRole('button', { name: 'Add plugin' })).toBeNull()
  })

  it('offers an icon-only store button that opens the plugin gallery', () => {
    openExternal.mockClear()
    renderGuidance(false)

    // Icon-only: the browse copy lives in the tooltip/aria-label, not as
    // visible text inside the card.
    const browse = screen.getByTestId('plugin-guide-browse-link')
    expect(browse).toHaveAccessibleName(
      'Discover plugins on Motrix official plugin marketplace'
    )
    expect(
      screen.queryByText(
        'Discover plugins on Motrix official plugin marketplace'
      )
    ).toBeNull()

    fireEvent.click(browse)
    expect(openExternal).toHaveBeenCalledWith(EXTERNAL_URLS.motrix.plugins)
  })

  it('renders only the compact reminder for a user-managed plugin', () => {
    renderGuidance(true)

    expect(screen.getByTestId('plugin-safety-reminder')).toBeInTheDocument()
    expect(
      screen.getByText(/Review access before enabling a plugin/i)
    ).toBeInTheDocument()
    expect(screen.queryByText('Add plugins you trust')).toBeNull()
    expect(screen.queryByTestId('plugin-guide-browse-link')).toBeNull()
  })
})
