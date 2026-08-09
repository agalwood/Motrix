// src/renderer/routes/dashboard/components/tile-error-boundary.tsx
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface ErrorFallbackProps {
  tile: string
  onRetry: () => void
}

function ErrorFallback({ tile, onRetry }: ErrorFallbackProps) {
  const { t } = useTranslation()
  return (
    <Card className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
      <span className="text-xs text-muted-foreground">
        ⚠️ {t('panel.dashboard.errors.tileFailed', { tile })}
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('panel.dashboard.errors.retry')}
      </Button>
    </Card>
  )
}

interface Props {
  tile: string
  className?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

export class TileErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `TileErrorBoundary[${this.props.tile}]`,
      error,
      info.componentStack
    )
  }

  retry = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    // `grid min-h-0`: 1-cell grid stretches the single child to fill the dashboard grid cell.
    return (
      <div className={cn('grid min-h-0', this.props.className)}>
        {error !== null ? (
          <ErrorFallback tile={this.props.tile} onRetry={this.retry} />
        ) : (
          this.props.children
        )}
      </div>
    )
  }
}
