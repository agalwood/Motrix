import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { DownloadDirectoryField } from '@/popup/DownloadDirectoryField'
import type { TaskOptions } from '@/shared/taskOptions'

export function TaskOptionsFields({
  value,
  onChange,
  disabled = false,
  magnet = false,
  browserCookies = false,
}: {
  value: TaskOptions
  onChange: (value: TaskOptions) => void
  disabled?: boolean
  magnet?: boolean
  browserCookies?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const field = (
    key: 'filename' | 'referer' | 'cookie' | 'authorization',
    secret = false
  ) => (
    <div className="grid min-w-0 gap-1.5" key={key}>
      <label className="text-xs font-medium" htmlFor={`${id}-${key}`}>
        {t(`popup.taskForm.${key}`)}
      </label>
      <Input
        id={`${id}-${key}`}
        dir={key === 'filename' ? 'auto' : 'ltr'}
        value={value[key]}
        placeholder={
          key === 'filename' ? t('popup.taskForm.filenameAuto') : undefined
        }
        className={key === 'filename' ? 'placeholder:text-xs' : undefined}
        disabled={disabled}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        maxLength={key === 'filename' ? 255 : 8192}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
      />
    </div>
  )
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {!magnet && field('filename')}
      <DownloadDirectoryField
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
      {!magnet && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium">
            {t('popup.taskForm.advanced')}
          </summary>
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 border-s ps-3">
            <div className="grid min-w-0 gap-1.5">
              <label
                className="text-xs font-medium"
                htmlFor={`${id}-userAgent`}
              >
                {t('popup.taskForm.userAgent')}
              </label>
              <Textarea
                id={`${id}-userAgent`}
                dir="ltr"
                value={value.userAgent}
                disabled={disabled}
                rows={3}
                maxLength={8192}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 max-h-32 resize-none text-xs md:text-xs [overflow-wrap:anywhere]"
                onChange={(event) =>
                  onChange({ ...value, userAgent: event.target.value })
                }
              />
            </div>
            {field('referer')}
            {browserCookies && (
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs" htmlFor={`${id}-cookies`}>
                  {t('popup.taskForm.browserCookies')}
                </label>
                <Switch
                  id={`${id}-cookies`}
                  checked={value.useBrowserCookies}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({ ...value, useBrowserCookies: checked })
                  }
                />
              </div>
            )}
            {field('cookie', true)}
            {field('authorization', true)}
            <div className="grid min-w-0 gap-1.5">
              <label className="text-xs font-medium" htmlFor={`${id}-headers`}>
                {t('popup.taskForm.extraHeaders')}
              </label>
              <Textarea
                id={`${id}-headers`}
                dir="ltr"
                value={value.extraHeaders}
                disabled={disabled}
                rows={3}
                maxLength={16384}
                autoComplete="off"
                spellCheck={false}
                placeholder="X-Example: value"
                className="min-w-0 max-h-32 resize-none text-xs [overflow-wrap:anywhere]"
                onChange={(event) =>
                  onChange({ ...value, extraHeaders: event.target.value })
                }
              />
            </div>
          </div>
        </details>
      )}
    </div>
  )
}
