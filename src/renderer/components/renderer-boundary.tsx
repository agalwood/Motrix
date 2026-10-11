import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import {
  setRendererSurface,
  showRendererFailure,
} from '@renderer/lib/renderer-health'
import { Events } from '@shared/protocol/events'
import { Component, type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

export class RendererBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    showRendererFailure('root')
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
export function RendererReady() {
  useEffect(() => {
    setRendererSurface('app')
  }, [])
  return null
}
export function RootRouteFailure() {
  const navigate = useNavigate()
  useIpcEvent(Events.NavigateTo, (...args) => {
    if (typeof args[0] === 'string') return navigate(args[0])
  })
  return <RouteFailure />
}
export function RouteFailure() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  useEffect(() => {
    setRendererSurface('route-error')
    return () => {
      setRendererSurface('app')
    }
  }, [])
  return (
    <section
      role="alert"
      className="flex h-svh flex-col items-center justify-center gap-4 p-8"
    >
      <h1>{t('rendererRecovery.routeTitle')}</h1>
      <button type="button" onClick={() => void navigate('/downloads/all')}>
        {t('rendererRecovery.downloads')}
      </button>
    </section>
  )
}
