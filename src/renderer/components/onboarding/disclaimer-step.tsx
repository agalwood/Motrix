import { BlurHighlight } from '@renderer/components/ui/blur-highlight'
import { Button } from '@renderer/components/ui/button'
import { isCjkLocale } from '@renderer/lib/locale-script'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function DisclaimerStep() {
  const { i18n, t } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const useCjkSpacing = isCjkLocale(language)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const agree = async () => {
    setFailed(false)
    setBusy(true)
    try {
      await transport.invoke(Commands.AcceptDisclaimer)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const quit = () => {
    void transport.invoke(Commands.DeclineDisclaimer)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col px-5 pt-4 pb-5 text-foreground">
      <section
        data-testid="disclaimer-panel"
        aria-labelledby="disclaimer-title"
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card px-6 py-6 text-card-foreground shadow-sm"
      >
        <div className="space-y-4">
          <h1
            id="disclaimer-title"
            className="text-[24px] leading-8 font-semibold tracking-[-0.02em]"
          >
            {t('onboarding.disclaimer.title')}
          </h1>
          <p className="text-[14px] leading-6 text-card-foreground/80">
            {t('onboarding.disclaimer.summary')}
          </p>
        </div>

        <BlurHighlight
          key={language}
          highlightedBits={[
            t('onboarding.disclaimer.highlights.downloadManagement'),
            t('onboarding.disclaimer.highlights.authorized'),
            t('onboarding.disclaimer.highlights.responsibility'),
          ]}
          highlightColor="currentColor"
          highlightClassName="font-medium"
          viewportOptions={{ once: true, amount: 0.5 }}
          className={cn(
            'mt-6 text-[14px] tracking-[-0.006em] text-card-foreground',
            useCjkSpacing ? 'leading-[2.5]' : 'leading-[1.9]'
          )}
        >
          {t('onboarding.disclaimer.body')}
        </BlurHighlight>

        <p
          className={cn(
            'text-[13px] leading-5 text-muted-foreground',
            useCjkSpacing ? 'mt-8' : 'mt-6'
          )}
        >
          {t('onboarding.disclaimer.localConsent')}
        </p>

        {failed && (
          <p
            data-testid="disclaimer-error"
            role="alert"
            className="mt-4 text-[13px] leading-5 text-destructive"
          >
            {t('onboarding.disclaimer.saveFailed')}
          </p>
        )}
      </section>

      <div className="shrink-0 space-y-3 pt-4">
        <Button
          size="lg"
          onClick={() => void agree()}
          disabled={busy}
          data-testid="disclaimer-agree"
          className="w-full rounded-lg"
        >
          {failed
            ? t('onboarding.disclaimer.retry')
            : t('onboarding.disclaimer.agree')}
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={quit}
          disabled={busy}
          data-testid="disclaimer-quit"
          className="w-full rounded-lg"
        >
          {t('onboarding.disclaimer.quit')}
        </Button>
      </div>
    </main>
  )
}
