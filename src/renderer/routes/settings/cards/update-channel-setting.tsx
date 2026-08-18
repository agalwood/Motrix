import { ButtonGroup } from '@renderer/components/ui/button-group'
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
  warningId?: string
  onChannelChanged?: (channel: AppUpdateChannel) => void
}

export function UpdateChannelSetting({
  disabled = false,
  children,
  warningId,
  onChannelChanged,
}: UpdateChannelSettingProps) {
  const { t } = useTranslation()
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = `${id}-description`
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

  useEffect(() => {
    onChannelChanged?.(channel)
  }, [channel, onChannelChanged])

  const saveChannel = useCallback(
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
      <ButtonGroup
        className="max-w-full shrink-0 gap-1 rounded-md bg-primary py-1 ps-1 pe-1.5 shadow-xs [&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-sm!"
        aria-label={t('settings.about.update.title')}
      >
        {children}
        <Select
          items={options}
          value={channel}
          disabled={disabled || pending}
          onValueChange={(value) => void saveChannel(value)}
        >
          <SelectTrigger
            id={id}
            size="sm"
            className="h-6! w-17 self-center justify-center gap-1.5 rounded-sm! border! bg-background! px-1.5 py-0 text-xs data-disabled:opacity-100! [&_svg]:size-3!"
            aria-labelledby={labelId}
            aria-describedby={
              channel === 'beta' && warningId
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
      </ButtonGroup>

      {failed && (
        <p className="max-w-sm text-[11px] leading-4 text-destructive">
          {t('settings.about.update.channelSaveError')}
        </p>
      )}
    </div>
  )
}
