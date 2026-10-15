import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { TakeoverConsentDialog } from '@/components/takeover-consent-dialog'
import { TakeoverPairingDialog } from '@/components/takeover-pairing-dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useTakeoverPairing } from '@/components/useTakeoverPairing'
import { SettingSection } from '@/options/components/SettingSection'
import type { TakeoverFormValues } from '@/options/tabs/schemas'
import { useTakeoverAvailability } from '@/options/useTakeoverAvailability'
import {
  supportsAutoOpenPopup,
  supportsDownloadTakeover,
} from '@/shared/platformCapabilities'
import { CONSENT_VERSION } from '@/shared/takeover'

export function TakeoverSection({
  form,
  consentAck,
  setConsentAck,
}: {
  form: UseFormReturn<TakeoverFormValues>
  consentAck: number
  setConsentAck: (version: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const unknownSizeItems = {
    chrome: t('options.takeover.unknownSizeBrowser'),
    motrix: t('options.takeover.unknownSizeMotrix'),
  }
  const availability = useTakeoverAvailability()
  const pairing = useTakeoverPairing()
  const availabilityRef = useRef(availability)
  availabilityRef.current = availability
  const confirmationSupported = supportsAutoOpenPopup()
  const [showConsent, setShowConsent] = useState(false)
  useEffect(() => {
    if (availability !== 'local') setShowConsent(false)
  }, [availability])
  return (
    <>
      <SettingSection
        title={t(
          supportsDownloadTakeover()
            ? 'options.takeover.title'
            : 'options.tabs.download'
        )}
      >
        <FieldGroup>
          <FormField
            control={form.control}
            name="downloadMode"
            render={({ field }) => (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="download-mode">
                    {t('options.downloadMode.label')}
                  </FieldLabel>
                  <FieldDescription id="download-mode-description">
                    {confirmationSupported
                      ? t(
                          supportsDownloadTakeover()
                            ? 'options.downloadMode.description'
                            : 'safari.confirmDownloadDescription'
                        )
                      : t(
                          availability === 'unsupported'
                            ? 'safari.unsupportedFeature'
                            : 'options.taskPanel.unsupported'
                        )}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="download-mode"
                  checked={field.value === 'confirm'}
                  disabled={!confirmationSupported && field.value !== 'confirm'}
                  onCheckedChange={(checked) =>
                    field.onChange(checked ? 'confirm' : 'direct')
                  }
                  aria-describedby="download-mode-description"
                />
              </Field>
            )}
          />
          {supportsDownloadTakeover() && (
            <>
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="download-enabled">
                        {t('options.takeover.enableLabel')}
                      </FieldLabel>
                      {availability !== 'local' && (
                        <FieldDescription id="download-takeover-unavailable">
                          {t(
                            availability === 'unsupported'
                              ? 'safari.unsupportedFeature'
                              : availability === 'remote'
                                ? 'options.takeover.remoteUnavailable'
                                : 'options.takeover.availabilityUnknown'
                          )}
                        </FieldDescription>
                      )}
                    </FieldContent>
                    <Switch
                      id="download-enabled"
                      checked={availability === 'local' && field.value}
                      disabled={availability !== 'local' || pairing.checking}
                      aria-describedby={
                        availability !== 'local'
                          ? 'download-takeover-unavailable'
                          : undefined
                      }
                      aria-label={t('options.takeover.enableAria')}
                      onCheckedChange={async (checked) => {
                        if (availability !== 'local') return
                        if (
                          checked &&
                          (!(await pairing.check()) ||
                            availabilityRef.current !== 'local')
                        )
                          return
                        if (checked && consentAck < CONSENT_VERSION) {
                          setShowConsent(true)
                          return
                        }
                        field.onChange(checked)
                      }}
                    />
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="thresholdMB"
                render={({ field, fieldState }) => (
                  <Field orientation="responsive">
                    <FieldContent>
                      <FieldLabel htmlFor="download-threshold">
                        {t('options.takeover.minSizeLabel')}
                      </FieldLabel>
                    </FieldContent>
                    <Input
                      id="download-threshold"
                      type="number"
                      className="bg-background @md/field-group:w-40"
                      placeholder={t('options.takeover.minSizePlaceholder')}
                      aria-invalid={fieldState.invalid}
                      {...field}
                    />
                    {fieldState.invalid && (
                      <FieldError
                        errors={[
                          { message: t(fieldState.error?.message ?? '') },
                        ]}
                      />
                    )}
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="unknownSizeAction"
                render={({ field }) => (
                  <Field orientation="responsive">
                    <FieldContent>
                      <FieldLabel htmlFor="download-unknown-size">
                        {t('options.takeover.unknownSizeLabel')}
                      </FieldLabel>
                    </FieldContent>
                    <Select
                      items={unknownSizeItems}
                      value={field.value}
                      onValueChange={(value) => {
                        if (value !== null) field.onChange(value)
                      }}
                    >
                      <SelectTrigger
                        id="download-unknown-size"
                        className="min-w-48"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chrome">
                          {unknownSizeItems.chrome}
                        </SelectItem>
                        <SelectItem value="motrix">
                          {unknownSizeItems.motrix}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="denylist"
                render={({ field }) => (
                  <Field orientation="vertical">
                    <FieldLabel htmlFor="download-denylist">
                      {t('options.takeover.denylistLabel')}
                    </FieldLabel>
                    <Textarea
                      id="download-denylist"
                      className="min-h-20"
                      {...field}
                    />
                  </Field>
                )}
              />
            </>
          )}
        </FieldGroup>
      </SettingSection>

      {pairing.error && (
        <p role="alert" className="text-sm text-destructive">
          {t('options.common.loadError')}
        </p>
      )}
      <TakeoverPairingDialog
        open={pairing.required && availability === 'local'}
        onCancel={pairing.cancel}
      />
      <TakeoverConsentDialog
        open={showConsent && availability === 'local'}
        saving={pairing.checking}
        onConfirm={async () => {
          if (availability !== 'local') return
          if (!(await pairing.check()) || availabilityRef.current !== 'local') {
            setShowConsent(false)
            return
          }
          setConsentAck(CONSENT_VERSION)
          form.setValue('enabled', true, { shouldDirty: true })
          setShowConsent(false)
        }}
        onCancel={() => setShowConsent(false)}
      />
    </>
  )
}
