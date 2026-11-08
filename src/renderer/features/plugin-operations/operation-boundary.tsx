import { Button } from '@renderer/components/ui/button'
import { Component, type ReactNode } from 'react'
export class OperationsBoundary extends Component<
  {
    children: ReactNode
    message: string
    retry: string
  },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed)
      return (
        <div role="alert" className="space-y-3 rounded-lg border p-4 text-sm">
          <p>{this.props.message}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => this.setState({ failed: false })}
          >
            {this.props.retry}
          </Button>
        </div>
      )
    return this.props.children
  }
}
