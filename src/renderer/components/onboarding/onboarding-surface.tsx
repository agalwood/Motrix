import type { ReactNode } from 'react'

interface OnboardingSurfaceProps {
  children: ReactNode
}

export function OnboardingSurface({ children }: OnboardingSurfaceProps) {
  return (
    <div
      data-slot="onboarding-surface"
      className="relative isolate flex h-screen min-h-0 flex-col overflow-hidden bg-[#f7f7f8] text-[#1d1d1f]"
      style={{ colorScheme: 'light' }}
    >
      {children}
    </div>
  )
}
