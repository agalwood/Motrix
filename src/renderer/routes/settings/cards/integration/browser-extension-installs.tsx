import { buttonVariants } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { useTranslation } from 'react-i18next'
import chromeIcon from '../../icons/browser-chrome.svg'
import edgeIcon from '../../icons/browser-edge.png'
import firefoxIcon from '../../icons/browser-firefox.png'
import githubIcon from '../../icons/browser-github.svg'
import githubWhiteIcon from '../../icons/browser-github-white.svg'

const INSTALL_OPTIONS = [
  {
    id: 'chrome',
    icon: chromeIcon,
    href: EXTERNAL_URLS.browserExtension.chrome,
    status: 'store',
  },
  {
    id: 'edge',
    icon: edgeIcon,
    href: EXTERNAL_URLS.browserExtension.edge,
    status: 'store',
  },
  {
    id: 'firefox',
    icon: firefoxIcon,
    href: EXTERNAL_URLS.browserExtension.firefox,
    status: 'store',
  },
  {
    id: 'github',
    icon: githubIcon,
    href: EXTERNAL_URLS.browserExtension.development,
    status: 'development',
  },
] as const

export function BrowserExtensionInstalls() {
  const { t } = useTranslation()

  return (
    <div className="grid w-full grid-cols-4 gap-2">
      {INSTALL_OPTIONS.map((option) => {
        const className = cn(
          buttonVariants({ variant: 'outline' }),
          'h-20 w-full min-w-0 flex-col gap-1 whitespace-normal px-1 text-center'
        )
        const content = (
          <>
            <img
              src={option.icon}
              alt=""
              className={cn('size-5', option.id === 'github' && 'dark:hidden')}
            />
            {option.id === 'github' && (
              <img
                src={githubWhiteIcon}
                alt=""
                className="hidden size-5 dark:block"
              />
            )}
            <span className="text-[11px] font-medium leading-tight">
              {t(`settings.integration.browser.install.${option.id}`)}
            </span>
            <span className="text-[10px] leading-tight text-muted-foreground">
              {t(`settings.integration.browser.install.${option.status}`)}
            </span>
          </>
        )

        return (
          <a
            key={option.id}
            href={option.href}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {content}
          </a>
        )
      })}
    </div>
  )
}
