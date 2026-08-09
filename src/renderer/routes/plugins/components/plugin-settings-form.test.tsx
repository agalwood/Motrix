import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import type { JsonSchemaNode } from '@shared/types/plugin'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: invokeMock,
    on: vi.fn(),
    off: vi.fn(),
  },
}))

import { PluginSettingsForm } from './plugin-settings-form'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

const SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    displayName: {
      type: 'string',
      title: 'Display name',
      description: 'Shown in generated filenames.',
    },
    enabled: { type: 'boolean', title: 'Enabled', default: false },
    retries: {
      type: 'integer',
      title: 'Retries',
      minimum: 0,
      maximum: 10,
      default: 2,
    },
    mode: {
      type: 'string',
      title: 'Mode',
      enum: ['fast', 'safe'],
      default: 'safe',
    },
    token: { type: 'string', title: 'Token', secret: true },
    notes: { type: 'string' },
  },
  required: ['displayName', 'enabled', 'retries', 'mode', 'token', 'notes'],
}

const INITIAL_VALUES = {
  displayName: 'Alice',
  enabled: true,
  retries: 3,
  mode: 'fast',
  token: 'secret-value',
  notes: 'memo',
}

function renderForm() {
  return render(
    <PluginSettingsForm
      pluginId="alice.demo"
      schema={SCHEMA}
      initialValues={INITIAL_VALUES}
    />
  )
}

describe('PluginSettingsForm', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it('renders every supported field type and plugin-provided copy', () => {
    renderForm()

    expect(screen.getByText('Display name')).toBeInTheDocument()
    expect(
      screen.getByText('Shown in generated filenames.')
    ).toBeInTheDocument()
    expect(screen.getByText('notes')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(3)
    expect(screen.getByRole('combobox')).toHaveTextContent('fast')
    expect(screen.getByDisplayValue('secret-value')).toHaveAttribute(
      'type',
      'password'
    )
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('persists only dirty fields and resets dirty state after save', async () => {
    const user = userEvent.setup()
    renderForm()
    const nameInput = screen.getByDisplayValue('Alice')

    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(Commands.UpdatePluginConfig, {
        pluginId: 'alice.demo',
        patch: { displayName: 'Bob' },
      })
    })
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('submits boolean and numeric edits through their typed controls', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Increment' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(Commands.UpdatePluginConfig, {
        pluginId: 'alice.demo',
        patch: { enabled: false, retries: 4 },
      })
    })
  })

  it('discards unsaved edits when reset is clicked', async () => {
    const user = userEvent.setup()
    renderForm()
    const notesInput = screen.getByDisplayValue('memo')

    await user.clear(notesInput)
    await user.type(notesInput, 'changed')
    await user.click(screen.getByRole('button', { name: 'Reset' }))

    expect(screen.getByDisplayValue('memo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
