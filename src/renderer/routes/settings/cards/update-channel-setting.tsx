import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { appUpdateChannelSchema } from '@shared/schemas'
import type { AppUpdateChannel } from '@shared/types/settings'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

const settingsChannelSchema = z.object({
  app: z.object({ updateChannel: appUpdateChannelSchema }),
})

interface UpdateChannelSettingProps {
  disabled?: boolean
  children?: ReactNode
}

export function UpdateChannelSetting({
  disabled = false,
  children,
}: UpdateChannelSettingProps) {
  const { t } = useTranslation()
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = `${id}-description`
  const warningId = `${id}-warning`
  const [channel, setChannel] = useState<AppUpdateChannel>('stable')
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)
  const options = useMemo(
    () => [
      {
        value: 'stable' as const,
        label: t('settings.about.update.channelStable'),
      },
      {
        value: 'beta' as const,
        label: t('settings.about.update.channelBeta'),
      },
    ],
    [t]
  )

  useEffect(() => {
    let active = true
    void transport
      .invoke(Queries.GetSettings)
      .then((value) => {
        if (!active) return
        const parsed = settingsChannelSchema.safeParse(value)
        if (parsed.success) {
          setChannel(parsed.data.app.updateChannel)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setPending(false)
      })
    return () => {
      active = false
    }
  }, [])

  const onChannelChange = useCallback(
    async (value: unknown) => {
      const parsed = appUpdateChannelSchema.safeParse(value)
      if (!parsed.success || parsed.data === channel) return
      const previous = channel
      setChannel(parsed.data)
      setPending(true)
      setFailed(false)
      try {
        await transport.invoke(Commands.UpdateSettings, {
          app: { updateChannel: parsed.data },
        })
      } catch {
        setChannel(previous)
        setFailed(true)
      } finally {
        setPending(false)
      }
    },
    [channel]
  )

  return (
    <div
      className="flex min-w-0 flex-col items-start gap-2 sm:items-end"
      aria-live="polite"
    >
      <p id={descriptionId} className="sr-only">
        {t('settings.about.update.channelDescription')}
      </p>
      <span id={labelId} className="sr-only">
        {t('settings.about.update.channelLabel')}
      </span>
      <div className="flex max-w-full items-center gap-2">
        <Select
          items={options}
          value={channel}
          disabled={disabled || pending}
          onValueChange={(value) => void onChannelChange(value)}
        >
          <SelectTrigger
            id={id}
            size="sm"
            className="w-28"
            aria-labelledby={labelId}
            aria-describedby={
              channel === 'beta'
                ? `${descriptionId} ${warningId}`
                : descriptionId
            }
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {children}
      </div>

      {failed && (
        <p className="max-w-sm text-[11px] leading-4 text-destructive">
          {t('settings.about.update.channelSaveError')}
        </p>
      )}

      {channel === 'beta' && (
        <p
          id={warningId}
          className="max-w-sm rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-[11px] leading-4 text-amber-900 dark:text-amber-200"
        >
          {t('settings.about.update.channelBetaWarning')}
        </p>
      )}
    </div>
  )
}
