import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import {
  CliInstallCapability,
  type CliInstallPackageManager,
  CliPackageManager,
  type CliPackageManagerOption,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliToolSection } from './cli-tool-section'
import { useCliTool } from './use-cli-tool'

vi.mock('./use-cli-tool', () => ({
  useCliTool: vi.fn(),
}))

const install = vi.fn(async () => {})
const refresh = vi.fn(async () => {})
const selectManager = vi.fn()

const MANAGER_OPTIONS: CliPackageManagerOption[] = [
  {
    manager: CliPackageManager.Npm,
    installCommand: 'npm install -g @motrix/cli@latest',
    available: true,
  },
  {
    manager: CliPackageManager.Pnpm,
    installCommand: 'pnpm add -g @motrix/cli@latest',
    available: true,
  },
  {
    manager: CliPackageManager.Yarn,
    installCommand: 'yarn global add @motrix/cli@latest',
    available: false,
  },
  {
    manager: CliPackageManager.Bun,
    installCommand: 'bun add -g @motrix/cli@latest',
    available: true,
  },
  {
    manager: CliPackageManager.Volta,
    installCommand: 'volta install @motrix/cli@latest',
    available: false,
  },
]

const BASE_STATUS: CliToolStatus = {
  phase: CliToolPhase.Ready,
  capability: CliInstallCapability.Direct,
  installCommand: 'pnpm add -g @motrix/cli@latest',
  packageManager: CliPackageManager.Pnpm,
  managerOptions: MANAGER_OPTIONS,
  version: null,
  executablePath: null,
  nodeVersion: 'v22.18.0',
  reason: null,
  detail: null,
}

interface SelectedCommand {
  manager: CliInstallPackageManager
  command: string
}

function renderStatus(
  status: CliToolStatus,
  isRefreshing = false,
  selected: SelectedCommand = {
    manager: CliPackageManager.Pnpm,
    command: 'pnpm add -g @motrix/cli@latest',
  }
) {
  vi.mocked(useCliTool).mockReturnValue({
    status,
    selectedManager: selected.manager,
    selectedCommand: selected.command,
    isRefreshing,
    selectManager,
    install,
    refresh,
  })
  return render(<CliToolSection />)
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('CliToolSection', () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {}
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {}
    }
  })

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    install.mockClear()
    refresh.mockClear()
    selectManager.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn() },
    })
  })

  it.each([
    [CliToolPhase.Ready, 'Ready to install', 'Install'],
    [CliToolPhase.Installed, 'Installed', 'Check again'],
    [CliToolPhase.ManualOnly, 'Manual install', 'Check again'],
    [CliToolPhase.NeedsAttention, 'Needs attention', 'Check again'],
    [CliToolPhase.Error, 'Failed', 'Check again'],
  ])('renders the %s terminal state', (phase, badge, action) => {
    renderStatus({
      ...BASE_STATUS,
      phase,
      reason:
        phase === CliToolPhase.Ready || phase === CliToolPhase.Installed
          ? null
          : CliToolReason.Unknown,
    })

    expect(screen.getByRole('status')).toHaveTextContent(badge)
    expect(screen.getByRole('button', { name: action })).toBeEnabled()
  })

  it('shows feedback and disables the action during a manual refresh', () => {
    const { container } = renderStatus(
      {
        ...BASE_STATUS,
        phase: CliToolPhase.Installed,
        version: '0.4.0',
        executablePath: '/Users/example/.local/bin/motrix',
      },
      true
    )

    expect(screen.getByRole('status')).toHaveTextContent('Installed')
    const action = screen.getByRole('button', { name: 'Checking…' })
    expect(action).toBeDisabled()
    expect(action).toContainElement(
      screen.getByRole('presentation', { hidden: true })
    )
    expect(screen.getByText('0.4.0')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Package manager' })
    ).toBeDisabled()
    const liveStatus = container.querySelector('.sr-only[aria-live="polite"]')
    expect(liveStatus).toHaveTextContent('Checking…')
    expect(liveStatus).toHaveAttribute('aria-atomic', 'true')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it.each([
    [CliToolPhase.Checking, 'Checking…'],
    [CliToolPhase.Installing, 'Installing…'],
  ])('disables the action during %s', (phase, action) => {
    renderStatus({ ...BASE_STATUS, phase })

    expect(screen.getByRole('button', { name: action })).toBeDisabled()
    expect(screen.getByRole('button', { name: action })).toContainElement(
      screen.getByRole('presentation', { hidden: true })
    )
    expect(
      screen.getByRole('combobox', { name: 'Package manager' })
    ).toBeDisabled()
  })

  it('starts an immediate install from the ready state', async () => {
    renderStatus(BASE_STATUS)

    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(install).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('places status after the title and the action in the card header', () => {
    const { container } = renderStatus(BASE_STATUS)
    const status = screen.getByRole('status')
    const title = screen.getByText('Motrix command-line tool')
    const action = screen.getByRole('button', { name: 'Install' })

    expect(
      title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(action.closest('[data-slot="card-action"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="card-footer"]')).toBeNull()
    expect(
      container.querySelector('.sr-only[aria-live="polite"]')
    ).toBeEmptyDOMElement()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('composes a full-width nested command ButtonGroup', () => {
    const { container } = renderStatus(BASE_STATUS)
    const outerGroup = container.querySelector(
      '[data-slot="button-group"].w-full'
    )

    expect(outerGroup).not.toBeNull()
    const innerGroups = outerGroup?.querySelectorAll(
      ':scope > [data-slot="button-group"]'
    )
    expect(innerGroups).toHaveLength(2)
    expect(innerGroups?.[0]).toContainElement(
      screen.getByRole('combobox', { name: 'Package manager' })
    )
    expect(innerGroups?.[0]).toContainElement(
      screen.getByRole('textbox', { name: 'Install command' })
    )
    expect(innerGroups?.[1]).toContainElement(
      screen.getByRole('button', { name: 'Copy install command' })
    )
  })

  it('lists all supported managers and disables unavailable direct options', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderStatus(BASE_STATUS)

    screen.getByRole('combobox', { name: 'Package manager' }).focus()
    await user.keyboard('{ArrowDown}')

    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual(['npm', 'pnpm', 'Yarn Classic', 'Bun', 'Volta'])
    expect(
      screen.getByRole('option', { name: 'Yarn Classic' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: 'Volta' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    const bun = screen.getByRole('option', { name: 'Bun' })
    expect(bun).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(bun)
    await waitFor(() =>
      expect(
        screen.queryByRole('option', { name: 'Bun' })
      ).not.toBeInTheDocument()
    )
  })

  it('allows unavailable managers for manual command copying', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderStatus({
      ...BASE_STATUS,
      phase: CliToolPhase.ManualOnly,
      capability: CliInstallCapability.ManualOnly,
      managerOptions: MANAGER_OPTIONS.map((option) => ({
        ...option,
        available: false,
      })),
    })

    screen.getByRole('combobox', { name: 'Package manager' }).focus()
    await user.keyboard('{ArrowDown}')
    const volta = screen.getByRole('option', { name: 'Volta' })
    expect(volta).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(volta)

    expect(selectManager).toHaveBeenCalledWith(CliPackageManager.Volta)
  })

  it('renders and copies the exact selected-manager command', async () => {
    renderStatus(BASE_STATUS, false, {
      manager: CliPackageManager.Volta,
      command: 'volta install @motrix/cli@latest',
    })

    const command = screen.getByRole('textbox', { name: 'Install command' })
    expect(command).toHaveValue('volta install @motrix/cli@latest')
    expect(command).toHaveAttribute('readonly')
    await userEvent.click(
      screen.getByRole('button', { name: 'Copy install command' })
    )
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'volta install @motrix/cli@latest'
      )
    )
  })

  it('renders verified metadata and local no-pair guidance', () => {
    renderStatus({
      ...BASE_STATUS,
      phase: CliToolPhase.Installed,
      version: '0.4.0',
      executablePath: '/Users/example/.local/bin/motrix',
    })

    expect(screen.getByText('0.4.0')).toBeInTheDocument()
    expect(
      screen.getByText('/Users/example/.local/bin/motrix')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Installed with').nextElementSibling
    ).toHaveTextContent('pnpm')
    expect(screen.getByText(/motrix --help/)).toBeInTheDocument()
    expect(screen.queryByText(/motrix pair/)).not.toBeInTheDocument()
  })

  it('keeps verified target metadata visible while PATH needs attention', () => {
    renderStatus({
      ...BASE_STATUS,
      phase: CliToolPhase.NeedsAttention,
      reason: CliToolReason.PathMissing,
      version: '0.4.0',
      executablePath: '/Users/example/.local/bin/motrix',
    })

    expect(screen.getByText('0.4.0')).toBeInTheDocument()
    expect(
      screen.getByText('/Users/example/.local/bin/motrix')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Installed with').nextElementSibling
    ).toHaveTextContent('pnpm')
  })

  it('renders a recovery alert and keeps diagnostics collapsed by default', () => {
    renderStatus({
      ...BASE_STATUS,
      phase: CliToolPhase.Error,
      reason: CliToolReason.Permission,
      detail: 'EACCES: sanitized diagnostic',
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/do not use sudo/i)
    expect(
      screen.queryByText('EACCES: sanitized diagnostic')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('EACCES: sanitized diagnostic')).toBeVisible()
  })

  it('refreshes manual-only and error states instead of installing', async () => {
    renderStatus({
      ...BASE_STATUS,
      phase: CliToolPhase.ManualOnly,
      capability: CliInstallCapability.ManualOnly,
      reason: CliToolReason.Sandboxed,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
  })
})
