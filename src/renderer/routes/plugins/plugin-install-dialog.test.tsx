import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import type {
  ConsentPayload,
  ConsentPayloadFfmpegRuntime,
} from '@shared/types/plugin-install'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockInstallState {
  pending: boolean
  error: string | null
  stagingId: string | null
  consent: ConsentPayload | null
  startInstall: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resetPresentation: ReturnType<typeof vi.fn>
}

const state: MockInstallState = {
  pending: false,
  error: null,
  stagingId: null,
  consent: null,
  startInstall: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  resetPresentation: vi.fn(),
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
  state.confirm = vi.fn().mockResolvedValue(true)
  state.cancel = vi.fn()
  state.resetPresentation = vi.fn()
})

describe('PluginInstallDialog', () => {
  it('starts a fresh input session and ignores an old file preparation when reopened during exit', async () => {
    let finishFile!: (value: {
      sourceType: 'local'
      absPath: string
      fileHash: string
    }) => void
    const prepare = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFile = resolve
        })
    )
    const services: PlatformServices = {
      kind: 'electron',
      pluginInstallFile: { mode: 'local-path', prepare },
      pickSaveDir: vi.fn(),
      closeHost: vi.fn(),
      readClipboard: vi.fn(),
      openExternal: vi.fn(),
      notify: vi.fn(),
    }
    const onOpenChange = vi.fn()
    const content = (open: boolean) => (
      <PlatformServicesProvider services={services}>
        <PluginInstallDialog open={open} onOpenChange={onOpenChange} />
      </PlatformServicesProvider>
    )
    const view = render(content(true))
    const dialog = screen.getByRole('dialog')
    const input = screen.getByPlaceholderText(/Paste a GitHub/i)
    const finishExit = holdExitAnimation(dialog)
    fireEvent.change(dialog.querySelector('input[type="file"]')!, {
      target: { files: [new File(['plugin'], 'old.moext')] },
    })
    expect(prepare).toHaveBeenCalledOnce()
    view.rerender(content(false))
    expect(dialog).toContainElement(input)
    expect(input).toHaveValue('old.moext')
    view.rerender(content(true))
    expect(screen.getByPlaceholderText(/Paste a GitHub/i)).not.toBe(input)
    expect(screen.getByPlaceholderText(/Paste a GitHub/i)).toHaveValue('')
    await act(async () =>
      finishFile({
        sourceType: 'local',
        absPath: '/old.moext',
        fileHash: 'a'.repeat(64),
      })
    )
    expect(state.startInstall).not.toHaveBeenCalled()
    view.rerender(content(false))
    await finishExit()
  })

  it('keeps the source input and its draft throughout exit', async () => {
    const props = { onOpenChange: vi.fn() }
    const view = render(<PluginInstallDialog open {...props} />)
    const input = screen.getByPlaceholderText(/Paste a GitHub/i)
    fireEvent.change(input, { target: { value: 'owner/repo' } })
    const dialog = screen.getByRole('dialog')
    const finish = holdExitAnimation(dialog)
    view.rerender(<PluginInstallDialog open={false} {...props} />)
    expect(dialog).toHaveAttribute('data-closed')
    expect(dialog).toContainElement(input)
    expect(input).toHaveValue('owner/repo')
    await finish()
  })

  it('renders only PluginInputGroup in stage 1', () => {
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByText('Add plugin')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Paste a GitHub/i)).toBeInTheDocument()
    expect(screen.queryByText('X')).toBeNull()
  })

  it('does not offer commit before consent is ready', () => {
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId('install-commit-btn')).toBeNull()
  })

  it('renders InlineConsentPanel when consent is loaded', () => {
    state.consent = consent
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(
      screen.getByRole('heading', { name: 'Install X 1.0?' })
    ).toBeInTheDocument()
    expect(screen.getByText(/This plugin is not verified/)).toBeInTheDocument()
    const install = screen.getByRole('button', { name: 'Allow and install' })
    expect(install).toBeEnabled()
  })

  it('Install button calls confirm', () => {
    state.consent = consent
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow and install' }))
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

  it('warns about a missing required runtime but still allows installation', () => {
    state.consent = withFfmpeg({
      available: false,
      satisfiesRange: false,
      requiredByPlugin: 'required',
    })
    state.stagingId = 's1'
    render(<PluginInstallDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId('ffmpeg-runtime-block')).not.toHaveClass(
      'text-destructive'
    )
    expect(screen.getByTestId('install-commit-btn')).toBeEnabled()
    fireEvent.click(screen.getByTestId('install-commit-btn'))
    expect(state.confirm).toHaveBeenCalled()
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
