import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { useTranslation } from 'react-i18next'
import { CreateTorrentForm } from './create-torrent-form'

export function CreateTorrentWindow() {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <WindowChrome
        variant="titled"
        maximizable={false}
        title={t('createTorrent.title')}
      />
      <CreateTorrentForm
        onClose={() =>
          void transport.invoke(Commands.CloseCurrentWindow, {
            showMain: 'if-visible',
          })
        }
      />
    </div>
  )
}
