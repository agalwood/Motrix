import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { dashboardTileViewport } from '../layout/dashboard-registry'
import { type EngineDisplayStatus, EngineTile } from './engine-tile'

const baseStatus = {
  state: 'ready' as const,
  version: '1.37.0',
  rpcPort: 16800,
  listenPort: 51413,
  failureReason: null,
} satisfies EngineDisplayStatus

const compactViewport = dashboardTileViewport('engine', { w: 1, h: 1 })
const summaryViewport = dashboardTileViewport('engine', { w: 2, h: 1 })
const tallDetailedViewport = dashboardTileViewport('engine', { w: 1, h: 2 })
const squareDetailedViewport = dashboardTileViewport('engine', { w: 2, h: 2 })

describe('EngineTile', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders the tile title in English', () => {
    render(<EngineTile status={baseStatus} viewport={summaryViewport} />)
    // TileShell uppercases the label via CSS, so the source value stays
    // proper-case "Engine" — never a hardcoded all-caps placeholder.
    expect(screen.getByText('Engine')).toBeInTheDocument()
  })

  it('localizes the tile title when the language switches to Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<EngineTile status={baseStatus} viewport={summaryViewport} />)
    expect(screen.getByText('引擎')).toBeInTheDocument()
  })

  it('renders Ready state with the ports and engine version', () => {
    const { container } = render(
      <EngineTile status={baseStatus} viewport={summaryViewport} />
    )
    const stateLabel = screen.getByText(/Ready|就绪/)
    const statusDot = container.querySelector<HTMLElement>(
      '[data-slot="status-dot"]'
    )

    expect(stateLabel).toBeInTheDocument()
    expect(screen.getByText(/16800/)).toBeInTheDocument()
    expect(screen.getByText(/51413/)).toBeInTheDocument()
    expect(screen.getByText('1.37.0')).toBeInTheDocument()
    expect(stateLabel.parentElement).toHaveClass(
      'h-8',
      'text-[22px]',
      'leading-none'
    )
    expect(stateLabel).toHaveClass('leading-[26px]')
    expect(stateLabel.parentElement).not.toContainElement(statusDot)
    expect(screen.getByTestId('engine-footer')).toContainElement(statusDot)
    expect(statusDot).toHaveAttribute('data-pulse', 'true')
  })

  it('renders Disconnected state', () => {
    render(
      <EngineTile
        status={{ ...baseStatus, state: 'disconnected' }}
        viewport={summaryViewport}
      />
    )
    expect(screen.getByText(/Disconnected|未连接/)).toBeInTheDocument()
  })

  it('exposes an engine diagnosis action', () => {
    render(<EngineTile status={baseStatus} viewport={summaryViewport} />)
    expect(
      screen.getByRole('button', { name: /Diagnose|诊断/i })
    ).toBeInTheDocument()
  })

  it('hides the secondary grid and keeps compact diagnosis access', () => {
    const { container } = render(
      <EngineTile status={baseStatus} viewport={compactViewport} />
    )
    const diagnoseButton = screen.getByRole('button', {
      name: /Diagnose|诊断/i,
    })
    const statusDot = container.querySelector<HTMLElement>(
      '[data-slot="status-dot"]'
    )

    expect(diagnoseButton).toBeVisible()
    expect(diagnoseButton).toHaveAttribute('data-variant', 'ghost')
    expect(screen.queryByTestId('engine-subs')).not.toBeInTheDocument()
    expect(screen.getByTestId('engine-footer')).toContainElement(statusDot)
    // Compact collapses the details to a single "aria2 v<version>" line.
    expect(screen.getByText(/aria2 v1\.37\.0/)).toBeInTheDocument()
  })

  it('renders Reconnecting state', () => {
    render(
      <EngineTile
        status={{ ...baseStatus, state: 'reconnecting' }}
        viewport={summaryViewport}
      />
    )
    expect(screen.getByText(/Reconnecting…|重连中…/)).toBeInTheDocument()
  })

  it('renders Failed state', () => {
    const { container } = render(
      <EngineTile
        status={{ ...baseStatus, state: 'failed' }}
        viewport={squareDetailedViewport}
      />
    )
    expect(screen.getByText(/Failed|失败/)).toBeInTheDocument()
    expect(screen.getByTestId('engine-failure')).toBeInTheDocument()
    expect(screen.getByTestId('engine-subs')).toHaveClass('grid-cols-3')
    expect(
      container.querySelector('[data-slot="status-dot"]')
    ).not.toHaveAttribute('data-pulse')
  })

  it('stacks detailed port sections in a tall viewport', () => {
    render(
      <EngineTile
        status={{ ...baseStatus, state: 'failed' }}
        viewport={tallDetailedViewport}
      />
    )

    expect(screen.getByTestId('engine-failure')).toBeInTheDocument()
    expect(screen.getByTestId('engine-subs')).toHaveClass(
      'grid-cols-1',
      'gap-2'
    )
    expect(screen.getByTestId('engine-footer')).toHaveClass('flex-col')
  })

  it('keeps the compact failed-state action subtle with a destructive icon', () => {
    render(
      <EngineTile
        status={{ ...baseStatus, state: 'failed' }}
        viewport={compactViewport}
      />
    )
    const diagnoseButton = screen.getByRole('button', {
      name: /Diagnose|诊断/i,
    })

    expect(diagnoseButton).toHaveAttribute('data-variant', 'ghost')
    expect(diagnoseButton.querySelector('svg')).toHaveClass('text-destructive')
  })
})
