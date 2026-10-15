import {
  BookOpenTextIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { FormField } from '@/components/ui/form'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { SettingRow } from '@/options/components/SettingRow'
import { SettingSection } from '@/options/components/SettingSection'
import { SettingsTabForm } from '@/options/components/SettingsTabForm'
import { SettingPanel } from '@/options/SettingPanel'
import { type HelpFormValues, helpFormSchema } from '@/options/tabs/schemas'
import { zodFormResolver } from '@/options/zodFormResolver'
import { extensionBrowser as browser } from '@/shared/browser'
import { LINKS } from '@/shared/links'
import { getLogLevel, setLogLevel } from '@/shared/logLevel'

export function HelpTab(): React.ReactElement {
  const { t } = useTranslation()
  const logLevelItems = {
    silent: t('options.diagnostics.logLevels.silent'),
    error: t('options.diagnostics.logLevels.error'),
    warn: t('options.diagnostics.logLevels.warn'),
    info: t('options.diagnostics.logLevels.info'),
    debug: t('options.diagnostics.logLevels.debug'),
  } satisfies Record<HelpFormValues['logLevel'], string>
  const form = useForm<HelpFormValues>({
    resolver: zodFormResolver(helpFormSchema),
    defaultValues: { logLevel: 'info' },
  })
  const [adapters, setAdapters] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  const extId = browser.runtime.id
  const version = browser.runtime.getManifest().version

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const level = await getLogLevel()
      if (!cancelled) form.reset({ logLevel: level })
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await send('bg.listAdapters', undefined)
        if (!cancelled) setAdapters(r.adapters.map((a) => a.id))
      } catch {
        // best-effort
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = async (values: HelpFormValues): Promise<void> => {
    await setLogLevel(values.logLevel)
  }

  const copyDiagnostics = async (): Promise<void> => {
    const text = [
      `Extension ID: ${extId}`,
      `Version: ${version}`,
      `Adapters: ${adapters.length ? adapters.join(', ') : 'none'}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // ignore clipboard failure
    }
  }

  return (
    <SettingPanel>
      <SettingSection title={t('options.help.title')}>
        <ItemGroup className="gap-0 overflow-hidden rounded-xl">
          <Item
            variant="muted"
            className="rounded-none transition-[color,background-color,border-color,transform] duration-100 ease-out active:scale-[0.995] motion-reduce:transform-none"
            render={<a href={LINKS.docs} target="_blank" rel="noreferrer" />}
          >
            <ItemMedia
              variant="icon"
              className="size-9 border rounded-lg bg-background text-foreground shadow-xs"
            >
              <BookOpenTextIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t('options.help.docs')}</ItemTitle>
              <ItemDescription>
                {t('options.help.docsDescription')}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRightIcon
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </ItemActions>
          </Item>
          <ItemSeparator className="my-0 ms-16" />
          <Item
            variant="muted"
            className="rounded-none transition-[color,background-color,border-color,transform] duration-100 ease-out active:scale-[0.995] motion-reduce:transform-none"
            render={<a href={LINKS.issues} target="_blank" rel="noreferrer" />}
          >
            <ItemMedia
              variant="icon"
              className="size-9 border rounded-lg bg-background text-foreground shadow-xs"
            >
              <BugIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t('options.help.reportBug')}</ItemTitle>
              <ItemDescription>
                {t('options.help.reportBugDescription')}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRightIcon
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingSection>

      <Separator className="my-5" />
      <SettingSection
        title={t('options.help.diagnostics')}
        description={t('options.help.diagnosticsDescription')}
        action={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void copyDiagnostics()}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied
              ? t('options.help.copied')
              : t('options.help.copyDiagnostics')}
          </Button>
        }
      >
        <SettingsTabForm form={form} onSubmit={onSubmit}>
          <FieldGroup>
            <FormField
              control={form.control}
              name="logLevel"
              render={({ field }) => (
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor="help-log-level">
                      {t('options.diagnostics.logLevel')}
                    </FieldLabel>
                  </FieldContent>
                  <Select
                    items={logLevelItems}
                    value={field.value}
                    onValueChange={(value) => {
                      if (value !== null) field.onChange(value)
                    }}
                  >
                    <SelectTrigger id="help-log-level" className="min-w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="silent">
                          {logLevelItems.silent}
                        </SelectItem>
                        <SelectItem value="error">
                          {logLevelItems.error}
                        </SelectItem>
                        <SelectItem value="warn">
                          {logLevelItems.warn}
                        </SelectItem>
                        <SelectItem value="info">
                          {logLevelItems.info}
                        </SelectItem>
                        <SelectItem value="debug">
                          {logLevelItems.debug}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
          </FieldGroup>
          <div className="flex flex-col gap-2 text-sm">
            <SettingRow label={t('options.diagnostics.extensionId')}>
              <span className="max-w-72 truncate font-mono text-xs">
                {extId}
              </span>
            </SettingRow>
            <SettingRow label={t('options.diagnostics.version')}>
              <span className="font-mono text-xs">{version}</span>
            </SettingRow>
            <SettingRow label={t('options.diagnostics.adapters')}>
              <span className="max-w-72 text-end text-xs">
                {adapters.length
                  ? adapters.join(', ')
                  : t('options.diagnostics.noneRegistered')}
              </span>
            </SettingRow>
          </div>
        </SettingsTabForm>
      </SettingSection>
    </SettingPanel>
  )
}
