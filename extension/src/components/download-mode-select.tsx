import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DownloadMode } from '@/shared/takeover'

export function DownloadModeSelect({
  id,
  value,
  confirmationSupported,
  disabled,
  describedBy,
  onChange,
}: {
  id: string
  value: DownloadMode
  confirmationSupported: boolean
  disabled?: boolean
  describedBy?: string
  onChange: (value: DownloadMode) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const items = ['confirm', 'direct'].map((mode) => ({
    value: mode,
    label: t(`options.downloadMode.${mode}`),
  }))
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === 'direct' || (next === 'confirm' && confirmationSupported))
          onChange(next)
      }}
    >
      <SelectTrigger
        id={id}
        className="min-w-48"
        aria-label={t('options.downloadMode.label')}
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            disabled={item.value === 'confirm' && !confirmationSupported}
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
