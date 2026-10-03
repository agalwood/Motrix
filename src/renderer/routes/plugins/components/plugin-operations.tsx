import { Button } from '@renderer/components/ui/button'
import { MediaMergeForm } from '@renderer/features/media-merge/media-merge-form'
import { MEDIA_MERGE_COMMAND } from '@shared/schemas/manual-media-merge'
import type { PluginManifestDTO } from '@shared/types/plugin'
import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/** Host-rendered operation panels opt in through a supported public command. */
export function hasPluginOperations(manifest: PluginManifestDTO): boolean {
  return (
    manifest.permissions.includes('ffmpeg') &&
    !!manifest.contributes.commands?.some(
      (command) =>
        command.public && command.id === `${manifest.id}.${MEDIA_MERGE_COMMAND}`
    )
  )
}

class OperationsBoundary extends Component<
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

export function PluginOperations({
  pluginId,
  enabled,
}: {
  pluginId: string
  enabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <OperationsBoundary
      key={pluginId}
      message={t('plugins.detail.operationsFailed')}
      retry={t('common.retry')}
    >
      <section className="mx-auto w-full max-w-2xl py-2">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight">
              {t('mediaMerge.title')}
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('mediaMerge.description')}
            </p>
          </div>
          <MediaMergeForm
            key={pluginId}
            pluginId={pluginId}
            enabled={enabled}
          />
        </div>
      </section>
    </OperationsBoundary>
  )
}
