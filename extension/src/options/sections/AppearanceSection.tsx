import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingSection } from '@/options/components/SettingSection'
import type { GeneralFormValues } from '@/options/tabs/schemas'
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '@/shared/supportedLocales'

export function AppearanceSection({
  form,
}: {
  form: UseFormReturn<GeneralFormValues>
}): React.ReactElement {
  const { t } = useTranslation()
  const themeItems = {
    system: t('options.appearance.theme.system'),
    light: t('options.appearance.theme.light'),
    dark: t('options.appearance.theme.dark'),
  } satisfies Record<GeneralFormValues['theme'], string>
  const languageItems = {
    system: t('options.language.system'),
    ...LOCALE_NAMES,
  } satisfies Record<GeneralFormValues['language'], string>

  return (
    <SettingSection title={t('options.appearance.title')}>
      <FieldGroup>
        <FormField
          control={form.control}
          name="theme"
          render={({ field }) => (
            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor="appearance-theme">
                  {t('options.appearance.theme.label')}
                </FieldLabel>
              </FieldContent>
              <Select
                items={themeItems}
                value={field.value}
                onValueChange={(value) => {
                  if (value !== null) field.onChange(value)
                }}
              >
                <SelectTrigger id="appearance-theme" className="min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="system">{themeItems.system}</SelectItem>
                    <SelectItem value="light">{themeItems.light}</SelectItem>
                    <SelectItem value="dark">{themeItems.dark}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <FormField
          control={form.control}
          name="language"
          render={({ field }) => (
            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor="appearance-language">
                  {t('options.language.label')}
                </FieldLabel>
              </FieldContent>
              <Select
                items={languageItems}
                value={field.value}
                onValueChange={(value) => {
                  if (value !== null) field.onChange(value)
                }}
              >
                <SelectTrigger id="appearance-language" className="min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="system">
                      {languageItems.system}
                    </SelectItem>
                    {SUPPORTED_LOCALES.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {languageItems[locale]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      </FieldGroup>
    </SettingSection>
  )
}
