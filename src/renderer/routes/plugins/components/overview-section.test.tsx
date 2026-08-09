import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PluginListDTO, PluginManifestDTO } from '@shared/types/plugin'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OverviewSection } from './overview-section'

function plugin(over: Partial<PluginListDTO> = {}): PluginListDTO {
  return {
    id: 'test.id',
    name: 'Test',
    version: '1.0',
    description: 'A test.',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
    ...over,
  } as PluginListDTO
}

function manifest(over: Partial<PluginManifestDTO> = {}): PluginManifestDTO {
  return {
    manifestVersion: 1,
    id: 'test.id',
    name: 'Test',
    version: '1.0',
    description: 'A test plugin description.',
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    activationEvents: [],
    categories: [],
    engines: { motrix: '^1.0.0' },
    main: 'index.js',
    contributes: {},
    ...over,
  } as PluginManifestDTO
}

describe('OverviewSection', () => {
  it('renders Ready hero for safe tone', () => {
    render(
      <OverviewSection
        plugin={plugin()}
        manifest={manifest()}
        onJumpToLogs={() => {}}
      />
    )
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('renders Needs attention hero when errorCount > 0', () => {
    render(
      <OverviewSection
        plugin={plugin({ errorCount: 2, lastError: 'Boom' })}
        manifest={manifest()}
        onJumpToLogs={() => {}}
      />
    )
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(
      screen.getByText('This plugin reported a problem')
    ).toBeInTheDocument()
    expect(screen.getByText('Boom')).toBeInTheDocument()
  })

  it('View issue button calls onJumpToLogs', () => {
    const onJumpToLogs = vi.fn()
    render(
      <OverviewSection
        plugin={plugin({ errorCount: 1 })}
        manifest={manifest()}
        onJumpToLogs={onJumpToLogs}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'View issue' }))
    expect(onJumpToLogs).toHaveBeenCalled()
  })

  it('Turned off hero shows when disabled', () => {
    render(
      <OverviewSection
        plugin={plugin({ enabled: false, status: 'disabled' })}
        manifest={manifest()}
        onJumpToLogs={() => {}}
      />
    )
    expect(screen.getAllByText('Turned off').length).toBeGreaterThan(0)
  })

  it('mini cards show Purpose / Access / Health', () => {
    render(
      <OverviewSection
        plugin={plugin()}
        manifest={manifest()}
        onJumpToLogs={() => {}}
      />
    )
    expect(screen.getByText('Purpose')).toBeInTheDocument()
    expect(screen.getAllByText('Access').length).toBeGreaterThan(0)
    expect(screen.getByText('Health')).toBeInTheDocument()
    expect(screen.getByText('All good')).toBeInTheDocument()
  })
})
