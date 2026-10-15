import type * as React from 'react'
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import type { useNotificationCapability } from '@/components/useNotificationCapability'
import { SettingSection } from '@/options/components/SettingSection'
import type { GeneralFormValues } from '@/options/tabs/schemas'

type DetailName = 'notifyConfirm' | 'notifyError' | 'notifyReminder'

export function NotificationsSection({
  form,
  notificationCapability,
}: {
  form: UseFormReturn<GeneralFormValues>
  notificationCapability: ReturnType<typeof useNotificationCapability>
}): React.ReactElement | null {
  const { t } = useTranslation()
  const master = form.watch('notifyMaster')
  const { capability, native, refresh } = notificationCapability
  const supported = capability.available
  const authorized = capability.authorization === 'authorized'
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const run = async (action: 'test' | 'settings') => {
    if (busy) return
    setBusy(true)
    setFeedback(null)
    try {
      if (action === 'test') {
        const { status } = await send('bg.testNotification', undefined)
        setFeedback(
          status === 'accepted'
            ? 'testAccepted'
            : status === 'suppressed'
              ? 'testSuppressed'
              : 'testFailed'
        )
      } else {
        const { opened } = await send('bg.openNotificationSettings', undefined)
        if (!opened) setFeedback('settingsFailed')
      }
      await refresh()
    } catch {
      setFeedback(action === 'test' ? 'testFailed' : 'settingsFailed')
    } finally {
      setBusy(false)
    }
  }
  if (!supported) return null

  const detailRow = (
    name: DetailName,
    labelKey: string,
    descKey: string
  ): React.ReactElement => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={name}>{t(labelKey)}</FieldLabel>
            <FieldDescription id={`${name}-description`}>
              {t(descKey)}
            </FieldDescription>
          </FieldContent>
          <Switch
            id={name}
            checked={field.value}
            aria-label={t(labelKey)}
            aria-describedby={`${name}-description`}
            onCheckedChange={field.onChange}
          />
        </Field>
      )}
    />
  )

  return (
    <SettingSection title={t('options.notifications.title')}>
      <FieldGroup>
        <FormField
          control={form.control}
          name="notifyMaster"
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="notify-master">
                  {t('options.notifications.masterLabel')}
                </FieldLabel>
                {native && !authorized && (
                  <FieldDescription id="notification-permission">
                    {t(
                      `options.notifications.${capability.authorization === 'denied' ? 'nativeDenied' : 'nativeNotDetermined'}`
                    )}
                  </FieldDescription>
                )}
              </FieldContent>
              <Switch
                id="notify-master"
                checked={field.value}
                disabled={
                  busy ||
                  form.formState.isSubmitting ||
                  (!authorized && !field.value)
                }
                aria-label={t('options.notifications.masterAria')}
                aria-describedby={
                  native && !authorized ? 'notification-permission' : undefined
                }
                onCheckedChange={field.onChange}
              />
            </Field>
          )}
        />
        {supported && master && (
          <>
            {detailRow(
              'notifyConfirm',
              'options.notifications.confirmLabel',
              'options.notifications.confirmDesc'
            )}
            {detailRow(
              'notifyError',
              'options.notifications.errorLabel',
              'options.notifications.errorDesc'
            )}
            {detailRow(
              'notifyReminder',
              'options.notifications.reminderLabel',
              'options.notifications.reminderDesc'
            )}
          </>
        )}
        {native && (
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || form.formState.isSubmitting}
              onClick={() => void run('settings')}
            >
              {t('options.notifications.configure')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || form.formState.isSubmitting || !authorized}
              onClick={() => void run('test')}
            >
              {t('options.notifications.test')}
            </Button>
          </div>
        )}
        {feedback && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(`options.notifications.${feedback}`)}
          </p>
        )}
      </FieldGroup>
    </SettingSection>
  )
}
