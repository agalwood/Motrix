import { Button } from '@renderer/components/ui/button'
import { Component, type ErrorInfo, Fragment, type ReactNode } from 'react'

export interface PluginCallGraphErrorBoundaryStrings {
  title: string
  description: string
  retry: string
  switchToTable: string
}

export interface PluginCallGraphErrorBoundaryProps {
  children: ReactNode
  strings: PluginCallGraphErrorBoundaryStrings
  onSwitchToTable: () => void
  onRetry?: () => void
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface PluginCallGraphErrorBoundaryState {
  failed: boolean
  generation: number
}

export class PluginCallGraphErrorBoundary extends Component<
  PluginCallGraphErrorBoundaryProps,
  PluginCallGraphErrorBoundaryState
> {
  state: PluginCallGraphErrorBoundaryState = {
    failed: false,
    generation: 0,
  }

  static getDerivedStateFromError(): Partial<PluginCallGraphErrorBoundaryState> {
    return { failed: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.props.onError?.(error, errorInfo)
  }

  private retry = () => {
    this.props.onRetry?.()
    this.setState((state) => ({
      failed: false,
      generation: state.generation + 1,
    }))
  }

  render() {
    if (this.state.failed) {
      const { strings } = this.props
      return (
        <div
          role="alert"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-destructive/40 bg-muted/20 p-6 text-center"
        >
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              {strings.title}
            </h3>
            <p className="max-w-md text-xs text-muted-foreground">
              {strings.description}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={this.retry}
            >
              {strings.retry}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={this.props.onSwitchToTable}
            >
              {strings.switchToTable}
            </Button>
          </div>
        </div>
      )
    }

    return (
      <Fragment key={this.state.generation}>{this.props.children}</Fragment>
    )
  }
}
