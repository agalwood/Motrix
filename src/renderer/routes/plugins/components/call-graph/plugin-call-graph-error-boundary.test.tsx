import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PluginCallGraphErrorBoundary,
  type PluginCallGraphErrorBoundaryStrings,
} from './plugin-call-graph-error-boundary'

const strings: PluginCallGraphErrorBoundaryStrings = {
  title: 'Relationship map unavailable',
  description: 'The visual map stopped rendering. The table is still usable.',
  retry: 'Reload visual map',
  switchToTable: 'Use relationship table',
}

function BrokenCanvas(): never {
  throw new Error('canvas render failed')
}

describe('PluginCallGraphErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('shows localized graph failure copy and keeps switch-to-Table operable', async () => {
    const user = userEvent.setup()
    const onSwitchToTable = vi.fn()
    const onError = vi.fn()
    const { getByRole, getByText } = render(
      <PluginCallGraphErrorBoundary
        strings={strings}
        onSwitchToTable={onSwitchToTable}
        onError={onError}
      >
        <BrokenCanvas />
      </PluginCallGraphErrorBoundary>
    )

    expect(getByRole('alert')).toBeInTheDocument()
    expect(getByText('Relationship map unavailable')).toBeInTheDocument()
    expect(
      getByText('The visual map stopped rendering. The table is still usable.')
    ).toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Object))

    await user.click(getByRole('button', { name: 'Use relationship table' }))
    expect(onSwitchToTable).toHaveBeenCalledOnce()
  })

  it('retries by remounting the canvas subtree', async () => {
    const user = userEvent.setup()
    let mayRender = false
    let mountedCanvases = 0

    function CanvasThatRecoversOnRemount() {
      useEffect(() => {
        mountedCanvases += 1
      }, [])
      if (!mayRender) throw new Error('canvas unavailable before retry')
      return <div>Canvas recovered</div>
    }

    const { getByRole, getByText } = render(
      <PluginCallGraphErrorBoundary
        strings={strings}
        onSwitchToTable={vi.fn()}
        onRetry={() => {
          mayRender = true
        }}
      >
        <CanvasThatRecoversOnRemount />
      </PluginCallGraphErrorBoundary>
    )

    expect(getByRole('alert')).toBeInTheDocument()
    await user.click(getByRole('button', { name: 'Reload visual map' }))

    expect(getByText('Canvas recovered')).toBeInTheDocument()
    expect(mountedCanvases).toBe(1)
  })
})
