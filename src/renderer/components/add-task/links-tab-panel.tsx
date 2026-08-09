import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { useTranslation } from 'react-i18next'
import { AdvancedPanel } from './advanced-panel'
import { UrlTextarea } from './url-textarea'

export function LinksTabPanel() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <UrlTextarea name="urls" autoFocus />
      <DirectoryPicker
        name="saveDir"
        variant="compact"
        prefixLabel={t('task.add.saveTo')}
        placeholder={t('task.add.saveDirEmpty')}
      />
      <AdvancedPanel />
    </div>
  )
}
