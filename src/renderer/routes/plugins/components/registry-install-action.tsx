import {
  CheckIcon,
  InstallIcon,
  PluginUpdateIcon,
} from '@renderer/components/icons'
import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PluginInstallDialog } from '../plugin-install-dialog'

interface Props {
  pluginId: string
  disabled?: boolean
  updateVersion?: string
}

export function RegistryInstallAction(props: Props) {
  return <RegistryInstallSession key={props.pluginId} {...props} />
}

function RegistryInstallSession({ pluginId, disabled, updateVersion }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [installed, setInstalled] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const updating = !!updateVersion
  return (
    <PluginInstallDialog
      open={open}
      onOpenChange={setOpen}
      onInstalled={() => setInstalled(true)}
      fixedSource={{ sourceType: 'registry', pluginId }}
      inlineErrors={!updating}
      returnFocusRef={triggerRef}
      renderTrigger={({ preparing, error, cancel, retry }) => (
        <>
          <Button
            ref={triggerRef}
            size="sm"
            variant={updating ? 'ghost' : 'default'}
            disabled={disabled || open || installed}
            aria-busy={preparing}
            aria-live="polite"
            onClick={() => setOpen(true)}
            data-testid={
              updating ? 'plugin-update-btn' : 'registry-install-btn'
            }
          >
            {preparing ? (
              <Spinner aria-hidden="true" />
            ) : installed ? (
              <CheckIcon />
            ) : updating ? (
              <PluginUpdateIcon />
            ) : (
              <InstallIcon />
            )}
            {preparing
              ? t('plugins.install.preparing')
              : installed
                ? t('plugins.install.installed')
                : updating
                  ? t('plugins.registry.updateTo', { version: updateVersion })
                  : t('plugins.registry.install')}
          </Button>
          {preparing && !updating && (
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t('common.cancel')}
            </Button>
          )}
          {!updating && error && (
            <Alert
              variant="destructive"
              className="basis-full min-w-0 border shadow-none"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 break-words text-xs leading-5">
                  {error}
                </span>
                <Button size="sm" variant="outline" onClick={retry}>
                  {t('common.retry')}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancel}>
                  {t('common.cancel')}
                </Button>
              </div>
            </Alert>
          )}
        </>
      )}
    />
  )
}
