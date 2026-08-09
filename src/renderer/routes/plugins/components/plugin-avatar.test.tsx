import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PluginAvatar } from './plugin-avatar'

describe('PluginAvatar', () => {
  it('renders initials fallback', () => {
    const { getByText } = render(
      <PluginAvatar
        plugin={{ id: 'test.demo-config', name: 'Demo Config Plugin' } as never}
      />
    )
    expect(getByText('DC')).toBeInTheDocument()
  })

  it('applies deterministic background tone class', () => {
    const { container, rerender } = render(
      <PluginAvatar plugin={{ id: 'stable.id', name: 'X' } as never} />
    )
    const fallback1 = container.querySelector('[data-slot="avatar-fallback"]')
    expect(fallback1).not.toBeNull()
    const first = fallback1!.className
    rerender(<PluginAvatar plugin={{ id: 'stable.id', name: 'X' } as never} />)
    const fallback2 = container.querySelector('[data-slot="avatar-fallback"]')
    const second = fallback2!.className
    expect(first).toBe(second)
    expect(first).toMatch(/bg-(blue|green|purple|pink|teal|indigo)-100/)
  })

  it('honors size prop', () => {
    const { container } = render(
      <PluginAvatar plugin={{ id: 'x', name: 'X' } as never} size={54} />
    )
    const avatar = container.querySelector('[data-slot="avatar"]')
    expect(avatar).toHaveStyle({ width: '54px', height: '54px' })
  })
})
