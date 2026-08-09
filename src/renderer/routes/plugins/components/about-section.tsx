import type { PluginManifestDTO } from '@shared/types/plugin'
import { useTranslation } from 'react-i18next'

interface Props {
  manifest: PluginManifestDTO
}

export function AboutSection({ manifest }: Props) {
  const { t } = useTranslation()
  return (
    <div className="w-full space-y-4">
      {manifest.description && (
        <p className="max-w-3xl text-sm leading-6">{manifest.description}</p>
      )}
      {manifest.author && (
        <div className="grid gap-1 text-sm sm:grid-cols-[120px_1fr]">
          <span className="text-muted-foreground">
            {t('plugins.detail.author')}
          </span>
          <span>{manifest.author}</span>
        </div>
      )}
      {manifest.homepage && (
        <div className="grid gap-1 text-sm sm:grid-cols-[120px_1fr]">
          <span className="text-muted-foreground">
            {t('plugins.detail.homepage')}
          </span>
          <a
            className="w-fit underline underline-offset-4"
            href={manifest.homepage}
            target="_blank"
            rel="noreferrer"
          >
            {manifest.homepage}
          </a>
        </div>
      )}
    </div>
  )
}
