import { Globe2Icon } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitHubMark } from '@/components/github-mark'
import { buttonVariants } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DownloadTab } from '@/options/tabs/DownloadTab'
import { GeneralTab } from '@/options/tabs/GeneralTab'
import { HelpTab } from '@/options/tabs/HelpTab'
import { IntegrationTab } from '@/options/tabs/IntegrationTab'
import { supportsBackendConnections } from '@/shared/browserKind'
import { LINKS } from '@/shared/links'
import { pairingActionFromHash } from '@/shared/pairingNavigation'

export function App(): React.ReactElement {
  const { t } = useTranslation()
  const [tab, setTab] = useState(() =>
    window.location.hash.startsWith('#integration') ? 'integration' : 'general'
  )
  const [pairingAction, setPairingAction] = useState(pairingActionFromHash)
  useEffect(() => {
    const navigate = (): void => {
      if (window.location.hash.startsWith('#integration')) {
        setTab('integration')
        setPairingAction(pairingActionFromHash())
      }
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  return (
    <TooltipProvider>
      <div className="min-h-screen w-full px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-7">
          <div className="space-y-5 rounded-[1.625rem] border border-border/70 bg-accent pt-5 p-2.5 shadow-card">
            <header className="flex flex-wrap items-center gap-4 px-3">
              <div className="flex min-w-0 items-center gap-4">
                <img src="/app-icon.png" alt="" className="size-14 shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    {t('options.title')}
                  </h1>
                  <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                    {t('options.about.subtitle')}
                  </p>
                </div>
              </div>
              <nav
                aria-label="Motrix"
                className="ms-auto flex shrink-0 items-center gap-1"
              >
                <a
                  href={LINKS.website}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('options.about.website')}
                  title={t('options.about.website')}
                  className={buttonVariants({
                    size: 'icon-sm',
                    variant: 'ghost',
                  })}
                >
                  <Globe2Icon aria-hidden="true" />
                </a>
                <a
                  href={LINKS.repo}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub"
                  title="GitHub"
                  className={buttonVariants({
                    size: 'icon-sm',
                    variant: 'ghost',
                  })}
                >
                  <GitHubMark />
                </a>
              </nav>
            </header>

            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(value as string)
                setPairingAction(null)
                window.history.replaceState(null, '', `#${value}`)
              }}
              className=""
            >
              <TabsList className="w-full bg-tab-background">
                <TabsTrigger value="general">
                  {t('options.tabs.general')}
                </TabsTrigger>
                {supportsBackendConnections() && (
                  <TabsTrigger value="download">
                    {t('options.tabs.download')}
                  </TabsTrigger>
                )}
                {supportsBackendConnections() && (
                  <TabsTrigger value="integration">
                    {t('options.tabs.integration')}
                  </TabsTrigger>
                )}
                <TabsTrigger value="help">{t('options.tabs.help')}</TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="">
                <GeneralTab />
              </TabsContent>
              {supportsBackendConnections() && (
                <TabsContent value="download" className="">
                  <DownloadTab />
                </TabsContent>
              )}
              {supportsBackendConnections() && (
                <TabsContent value="integration" className="">
                  <IntegrationTab
                    pairingAction={pairingAction}
                    onPairingActionHandled={() => {
                      setPairingAction(null)
                      window.history.replaceState(null, '', '#integration')
                    }}
                  />
                </TabsContent>
              )}
              <TabsContent value="help" className="">
                <HelpTab />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
