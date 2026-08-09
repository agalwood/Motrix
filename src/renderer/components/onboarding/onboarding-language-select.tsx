import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import {
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { useTranslation } from 'react-i18next'

const LANGUAGE_OPTIONS = SUPPORTED_LOCALES.map(({ code, nativeName }) => ({
  value: code,
  label: nativeName,
}))

export function OnboardingLanguageSelect() {
  const { i18n, t } = useTranslation()

  const changeLanguage = (language: SupportedLocale) => {
    void applyRendererLocale(language).catch(() => {})
    void transport
      .invoke(Commands.SetDisclaimerLanguage, language)
      .catch(() => {
        // Keep the immediately visible language if persistence fails. The user
        // can select it again before accepting the disclaimer.
      })
  }

  return (
    <div className="flex items-center pt-3.5">
      <Select
        items={LANGUAGE_OPTIONS}
        value={i18n.resolvedLanguage ?? i18n.language}
        onValueChange={(language) => {
          if (isSupportedLocale(language)) changeLanguage(language)
        }}
      >
        <SelectTrigger
          data-testid="onboarding-language"
          size="sm"
          aria-label={t('onboarding.disclaimer.language')}
          className="h-8 min-w-28 max-w-64 border-black/10 bg-white/88 text-[13px] text-[#1d1d1f] shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur-xl hover:bg-white"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
