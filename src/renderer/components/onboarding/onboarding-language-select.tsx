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
  isLanguagePreference,
  isSupportedLocale,
  type LanguagePreference,
  SUPPORTED_LOCALES,
} from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const LANGUAGE_OPTIONS = SUPPORTED_LOCALES.map(({ code, nativeName }) => ({
  value: code,
  label: nativeName,
}))

export function OnboardingLanguageSelect() {
  const { i18n, t } = useTranslation()
  const [preference, setPreference] = useState<LanguagePreference | null>(null)
  const revision = useRef(0)
  const languageOptions = [
    { value: 'system', label: t('settings.appearance.followSystem') },
    ...LANGUAGE_OPTIONS,
  ]

  useEffect(() => {
    let active = true
    const currentRevision = revision.current
    void transport
      .invoke(Queries.GetDisclaimerState)
      .then((state) => {
        if (!active || currentRevision !== revision.current) return
        const language = (state as { language?: unknown } | undefined)?.language
        if (isLanguagePreference(language)) setPreference(language)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const changeLanguage = (language: LanguagePreference) => {
    const currentRevision = ++revision.current
    setPreference(language)
    if (isSupportedLocale(language)) {
      void applyRendererLocale(language).catch(() => {})
    }
    void transport
      .invoke(Commands.SetDisclaimerLanguage, language)
      .then(() => transport.invoke(Queries.GetDisclaimerState))
      .then((state) => {
        if (currentRevision !== revision.current) return
        const resolved = (state as { resolvedLanguage?: unknown } | undefined)
          ?.resolvedLanguage
        if (isSupportedLocale(resolved)) return applyRendererLocale(resolved)
      })
      .catch(() => {
        // Keep the immediately visible language if persistence fails. The user
        // can select it again before accepting the disclaimer.
      })
  }

  return (
    <div className="flex items-center">
      <Select
        items={languageOptions}
        value={preference ?? i18n.resolvedLanguage ?? i18n.language}
        onValueChange={(language) => {
          if (isLanguagePreference(language)) changeLanguage(language)
        }}
      >
        <SelectTrigger
          data-testid="onboarding-language"
          size="sm"
          aria-label={t('onboarding.disclaimer.language')}
          className="h-8 min-w-28 max-w-64 border-border bg-card/88 text-[13px] text-card-foreground shadow-sm backdrop-blur-xl hover:bg-card"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {languageOptions.map((option) => (
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
