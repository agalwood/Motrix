import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import { TakeoverSection } from '@/options/sections/TakeoverSection'
import {
  type TakeoverFormValues,
  takeoverFormSchema,
} from '@/options/tabs/schemas'
import { configToForm, formToConfig } from '@/options/takeoverForm'
import { zodFormResolver } from '@/options/zodFormResolver'

export function DownloadTab(): React.ReactElement {
  const { t } = useTranslation()
  const [consentAck, setConsentAck] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const form = useForm<TakeoverFormValues>({
    resolver: zodFormResolver(takeoverFormSchema),
    defaultValues: {
      downloadMode: 'direct',
      enabled: false,
      thresholdMB: '',
      unknownSizeAction: 'chrome',
      denylist: '',
    },
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const takeover = await send('bg.getTakeoverConfig', undefined)
        if (cancelled) return
        form.reset(configToForm(takeover))
        setConsentAck(takeover.consentAckVersion)
        setLoadFailed(false)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  const onSubmit = async (values: TakeoverFormValues): Promise<void> => {
    await send('bg.setTakeoverConfig', formToConfig(values, consentAck))
  }

  return (
    <SettingPanel>
      {loadFailed && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {t('options.common.loadError')}
        </p>
      )}
      {!loadFailed && (
        <SettingsTabForm form={form} onSubmit={onSubmit}>
          <TakeoverSection
            form={form}
            consentAck={consentAck}
            setConsentAck={setConsentAck}
          />
        </SettingsTabForm>
      )}
    </SettingPanel>
  )
}
