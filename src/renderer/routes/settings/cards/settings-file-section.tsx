import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { FolderIcon } from '@renderer/components/icons'
import { SettingsLoadStatus } from '@renderer/components/settings-kit/use-settings-load'
import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import { Input } from '@renderer/components/ui/input'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { settingsFileLocationSchema } from '@shared/schemas/settings-file'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function SettingsFileSection() {
  const { t } = useTranslation()
  const titleId = useId()
  const descriptionId = useId()
  const [filePath, setFilePath] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const generation = useRef(0)
  const [opening, setOpening] = useState(false)
  const [actionError, setActionError] = useState(false)
  const isWeb = transport.platform === 'web'

  const loadPath = useCallback(async () => {
    const revision = ++generation.current
    setFilePath(null)
    setLoadError(false)
    try {
      const { path } = settingsFileLocationSchema.parse(
        await transport.invoke(Queries.GetSettingsFileLocation)
      )
      if (revision === generation.current) setFilePath(path)
    } catch {
      if (revision === generation.current) setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void loadPath()
    return () => {
      generation.current++
    }
  }, [loadPath])

  const openDirectory = async () => {
    setOpening(true)
    setActionError(false)
    try {
      const opened = await transport.invoke(Commands.OpenSettingsDirectory)
      setActionError(opened !== true)
    } catch {
      setActionError(true)
    } finally {
      setOpening(false)
    }
  }

  return (
    <section aria-labelledby={titleId} className="min-w-0 space-y-2">
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-semibold">
          {t('settings.advanced.configFile.title')}
        </h3>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {t(
            isWeb
              ? 'settings.advanced.configFile.serverDescription'
              : 'settings.advanced.configFile.desktopDescription'
          )}
        </p>
      </div>
      <SettingsLoadStatus
        ready={filePath !== null}
        error={loadError}
        retry={loadPath}
      />
      {filePath !== null && (
        <ButtonGroup className="w-full min-w-0" aria-labelledby={titleId}>
          <Input
            readOnly
            dir="ltr"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={filePath}
            title={filePath}
            className="h-8 min-w-0 font-mono text-xs"
          />
          {isWeb ? (
            <CopyButton
              variant="outline"
              size="icon-sm"
              className="gap-0"
              aria-label={t('settings.advanced.configFile.copyPath')}
              title={t('settings.advanced.configFile.copyPath')}
              content={() => {
                setActionError(false)
                return filePath
              }}
              copiedLabel={
                <span className="sr-only">
                  {t('settings.advanced.configFile.copied')}
                </span>
              }
              onCopyError={() => setActionError(true)}
            >
              <span className="sr-only">
                {t('settings.advanced.configFile.copyPath')}
              </span>
            </CopyButton>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('settings.advanced.configFile.openDirectory')}
              title={t('settings.advanced.configFile.openDirectory')}
              disabled={opening}
              aria-busy={opening}
              onClick={() => void openDirectory()}
            >
              <FolderIcon />
            </Button>
          )}
        </ButtonGroup>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {t('settings.advanced.configFile.actionFailed')}
        </p>
      )}
    </section>
  )
}
