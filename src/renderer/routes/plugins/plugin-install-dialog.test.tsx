import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type {
  ConsentPayload,
  ConsentPayloadFfmpegRuntime,
} from '@shared/types/plugin-install'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockInstallState {
  pending: boolean
  error: string | null
  stagingId: string | null
  consent: ConsentPayload | null
  startInstall: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const state: MockInstallState = {
  pending: false,
  error: null,
  stagingId: null,
  consent: null,
  startInstall: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
}

vi.mock('./hooks/use-plugin-install', () => ({
  usePluginInstall: () => state,
}))

import { PluginInstallDialog } from './plugin-install-dialog'

const consent: ConsentPayload = {
  manifest: {
    id: 'p.x',
    name: 'X',
    version: '1.0',
    description: 'A test plugin.',
  },
  source: { type: 'github', url: 'x/y', bundleSha256: 'aa', recordedAt: 0 },
  trustSurface: {
    permissions: [
      { name: 'storage', description: 'plugins.permission.storage.plain' },
    ],
    optionalPermissions: [],
    hostPermissions: [],
    invokesCommands: [],
    publicCommandsExposed: [],
    enginesMotrix: '^1.0.0',
    notVerified: true,
  },
  diff: null,
  ffmpegRuntime: { available: false, requiredByPlugin: 'none' },
}

beforeEach(() => {
  state.pending = false
  state.error = null
  state.stagingId = null
  state.consent = null
  state.startInstall = vi.fn()
  state.confirm = vi.fn()
  state.cancel = vi.fn()
})

describe('PluginInstallDialog', () => {
  it('renders only PluginInputGroup in stage 1', () => {
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByText('Add plugin')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Paste a GitHub/i)).toBeInTheDocument()
    expect(screen.queryByText('X')).toBeNull()
  })

  it('Install button is disabled while consent is null', () => {
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    const install = screen.getByRole('button', { name: 'Install plugin' })
    expect(install).toBeDisabled()
  })

  it('renders InlineConsentPanel when consent is loaded', () => {
    state.consent = consent
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByText('X')).toBeInTheDocument()
    expect(screen.getByText(/Before installing/)).toBeInTheDocument()
    const install = screen.getByRole('button', { name: 'Install plugin' })
    expect(install).toBeEnabled()
  })

  it('Install button calls confirm', () => {
    state.consent = consent
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }))
    expect(state.confirm).toHaveBeenCalled()
  })

  it('Cancel button calls cancel hook', () => {
    state.consent = consent
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(state.cancel).toHaveBeenCalled()
  })

  it('cancels existing staging before starting a new check', async () => {
    state.stagingId = 's_old'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/Paste a GitHub/i), {
      target: { value: 'owner/repo' },
    })
    fireEvent.click(screen.getByLabelText('Check this plugin'))
    await waitFor(() => expect(state.cancel).toHaveBeenCalled())
    expect(state.startInstall).toHaveBeenCalledWith({
      sourceType: 'github',
      spec: 'owner/repo',
    })
    expect(state.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      state.startInstall.mock.invocationCallOrder[0]
    )
  })
})

function withFfmpeg(rt: ConsentPayloadFfmpegRuntime): ConsentPayload {
  return { ...consent, ffmpegRuntime: rt }
}

describe('PluginInstallDialog — ffmpegRuntime block', () => {
  it('renders nothing for requiredByPlugin: "none"', () => {
    state.consent = withFfmpeg({ available: true, requiredByPlugin: 'none' })
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId('ffmpeg-runtime-block')).toBeNull()
    expect(screen.getByTestId('install-commit-btn')).toBeEnabled()
  })

  it('renders red ABORT block when required + !satisfies; disables commit', () => {
    state.consent = withFfmpeg({
      available: false,
      satisfiesRange: false,
      requiredByPlugin: 'required',
    })
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId('ffmpeg-runtime-block')).toHaveClass(
      /destructive/
    )
    expect(screen.getByTestId('install-commit-btn')).toBeDisabled()
  })

  it('renders yellow notice when optional + !available; commit enabled', () => {
    state.consent = withFfmpeg({
      available: false,
      satisfiesRange: false,
      requiredByPlugin: 'optional',
    })
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    const block = screen.getByTestId('ffmpeg-runtime-block')
    expect(block.className).toMatch(/amber|yellow|warning/)
    expect(screen.getByTestId('install-commit-btn')).toBeEnabled()
  })

  it('renders nothing when required + satisfies (all good)', () => {
    state.consent = withFfmpeg({
      available: true,
      version: '6.0.1',
      satisfiesRange: true,
      requiredByPlugin: 'required',
    })
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId('ffmpeg-runtime-block')).toBeNull()
    expect(screen.getByTestId('install-commit-btn')).toBeEnabled()
  })
})
