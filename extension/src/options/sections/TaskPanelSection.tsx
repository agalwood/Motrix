import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import { SettingSection } from '@/options/components/SettingSection'
import type { GeneralFormValues } from '@/options/tabs/schemas'
import {
  supportsAutoOpenPopup,
  supportsDownloadTakeover,
} from '@/shared/platformCapabilities'

export function TaskPanelSection({
  form,
}: {
  form: UseFormReturn<GeneralFormValues>
}): React.ReactElement {
  const { t } = useTranslation()
  const supported = supportsAutoOpenPopup()
  return (
    <SettingSection title={t('options.taskPanel.title')}>
      <FieldGroup>
        <FormField
          control={form.control}
          name="openTaskPanelAfterSubmit"
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="general-task-panel">
                  {t('options.taskPanel.openAfterSubmit')}
                </FieldLabel>
                <FieldDescription id="general-task-panel-description">
                  {t(
                    supportsDownloadTakeover()
                      ? 'options.taskPanel.description'
                      : 'safari.taskPanelDescription'
                  )}
                </FieldDescription>
                {!supported && (
                  <FieldDescription id="general-task-panel-unsupported">
                    {t(
                      supportsDownloadTakeover()
                        ? 'options.taskPanel.unsupported'
                        : 'safari.unsupportedFeature'
                    )}
                  </FieldDescription>
                )}
              </FieldContent>
              <Switch
                id="general-task-panel"
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={!supported}
                aria-describedby={
                  supported
                    ? 'general-task-panel-description'
                    : 'general-task-panel-description general-task-panel-unsupported'
                }
              />
            </Field>
          )}
        />
      </FieldGroup>
    </SettingSection>
  )
}
