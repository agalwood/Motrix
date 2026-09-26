import {
  ChevronDownIcon,
  ConcealIcon,
  RevealIcon,
} from '@renderer/components/icons'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@renderer/components/ui/input-group'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { ProxySettings } from '@shared/types/settings'
import type { SystemProxyResult } from '@shared/types/system-proxy'
import { useEffect, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { NetworkFields } from './network-dialog'

type ProxyScope = keyof ProxySettings['scopes']
const PROXY_SCOPES: ProxyScope[] = ['download', 'updateApp', 'updateTrackers']

export function ProxySection({ form }: { form: UseFormReturn<NetworkFields> }) {
  const { t } = useTranslation()
  const scopes = form.watch('proxy.scopes')
  const scopeLabels: Record<ProxyScope, string> = {
    download: t('settings.network.proxy.scopeDownload'),
    updateApp: t('settings.network.proxy.scopeUpdateApp'),
    updateTrackers: t('settings.network.proxy.scopeUpdateTrackers'),
  }

  // UI-only state. `showAuth` collapses the user/password rows when the
  // proxy doesn't need a login (the common case). `revealPassword`
  // mirrors AdvancedDialog's RPC-secret reveal pattern.
  const [showAuth, setShowAuth] = useState(false)
  const [revealPassword, setRevealPassword] = useState(false)

  // Seed `showAuth` once when settings hydrate proxy.user with a non-empty
  // value. After that, the toggle stays under user control via
  // handleAuthToggle below.
  const seededRef = useRef(false)
  const userValue = form.watch('proxy.user')
  useEffect(() => {
    if (!seededRef.current && userValue.length > 0) {
      setShowAuth(true)
      seededRef.current = true
    }
  }, [userValue])

  const proxyEnabled = form.watch('proxy.enabled')

  const updateProtocol = (protocol: ProxySettings['protocol']) => {
    form.setValue('proxy.protocol', protocol, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  const handleAuthToggle = (checked: boolean) => {
    setShowAuth(checked)
    if (!checked) {
      form.setValue('proxy.user', '', {
        shouldDirty: true,
        shouldValidate: true,
      })
      form.setValue('proxy.password', '', {
        shouldDirty: true,
        shouldValidate: true,
      })
      setRevealPassword(false)
    }
  }

  const handleImportFromSystem = async () => {
    const detected = (await transport.invoke(
      Queries.GetSystemProxy
    )) as SystemProxyResult | null
    if (!detected) {
      toast.add({
        title: t('settings.network.proxy.noSystemProxy'),
        type: 'info',
      })
      return
    }
    updateProtocol(detected.protocol)
    form.setValue('proxy.host', detected.host, {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('proxy.port', detected.port, {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('proxy.user', detected.user ?? '', {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('proxy.password', detected.password ?? '', {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('proxy.bypass', detected.bypass ?? [], {
      shouldDirty: true,
      shouldValidate: true,
    })
    const hasAuth = Boolean(detected.user || detected.password)
    setShowAuth(hasAuth)
    seededRef.current = hasAuth
    if (!hasAuth) setRevealPassword(false)
    // Importing implies the user wants to USE this proxy; flip the master
    // toggle on so the rest of the form reveals.
    if (!form.getValues('proxy.enabled')) {
      form.setValue('proxy.enabled', true, {
        shouldDirty: true,
        shouldValidate: true,
      })
    }
    toast.add({
      title: t('settings.network.proxy.importedToast', {
        host: detected.host,
        port: detected.port,
      }),
      type: 'success',
    })
  }

  return (
    <>
      {/* Proxy section header — Import button stays here so it
          remains accessible even when proxy.enabled is false. */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {t('settings.network.proxy.title')}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleImportFromSystem}
        >
          {t('settings.network.proxy.importFromSystem')}
        </Button>
      </div>

      {/* Master toggle — always visible */}
      <FormField
        control={form.control}
        name="proxy.enabled"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>{t('settings.network.proxy.enable')}</FormLabel>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </SettingsFormRow>
        )}
      />

      {/* Body — only when proxy is enabled */}
      {(proxyEnabled || form.formState.errors.proxy) && (
        <div className="space-y-4 border-s border-border/60 ps-4">
          {/* Server: protocol + host as one InputGroup, port adjacent */}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              {t('settings.network.proxy.server')}
            </p>
            <div className="flex items-start gap-2">
              <FormField
                control={form.control}
                name="proxy.host"
                render={({ field }) => (
                  <FormItem className="flex-1 space-y-0">
                    <InputGroup className="h-8">
                      <InputGroupAddon align="inline-start">
                        <FormField
                          control={form.control}
                          name="proxy.protocol"
                          render={({ field: protoField }) => (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <InputGroupButton
                                    variant="ghost"
                                    size="xs"
                                    className="uppercase"
                                  />
                                }
                              >
                                {protoField.value}
                                <ChevronDownIcon />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuRadioGroup
                                  value={protoField.value}
                                  onValueChange={(v) =>
                                    updateProtocol(
                                      v as ProxySettings['protocol']
                                    )
                                  }
                                >
                                  <DropdownMenuRadioItem value="http">
                                    HTTP
                                  </DropdownMenuRadioItem>
                                  <DropdownMenuRadioItem value="https">
                                    HTTPS
                                  </DropdownMenuRadioItem>
                                  <DropdownMenuRadioItem value="socks5">
                                    SOCKS5
                                  </DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        />
                        <InputGroupText>://</InputGroupText>
                      </InputGroupAddon>
                      <FormControl>
                        <InputGroupInput
                          {...field}
                          aria-label={t('settings.network.proxy.server')}
                          placeholder={t(
                            'settings.network.proxy.hostPlaceholder'
                          )}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                    </InputGroup>

                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="proxy.port"
                render={({ field }) => (
                  <FormItem className="w-30 space-y-0">
                    <InputGroup className="h-8">
                      <InputGroupAddon align="inline-start">
                        <InputGroupText>:</InputGroupText>
                      </InputGroupAddon>
                      <FormControl>
                        <InputGroupInput
                          {...field}
                          aria-label={t('settings.network.proxy.port')}
                          type="number"
                          min={1}
                          max={65535}
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </InputGroup>

                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />
            </div>
          </div>

          {/* Authentication — opt-in via UI-only Switch.
              User/password fields collapse when off. */}
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium leading-none">
                  {t('settings.network.proxy.auth')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.network.proxy.authDesc')}
                </p>
              </div>
              <Switch
                aria-label={t('settings.network.proxy.auth')}
                checked={showAuth}
                onCheckedChange={handleAuthToggle}
              />
            </div>
            {(showAuth ||
              form.formState.errors.proxy?.user ||
              form.formState.errors.proxy?.password) && (
              <div className="space-y-2 pt-1">
                <FormField
                  control={form.control}
                  name="proxy.user"
                  render={({ field }) => (
                    <SettingsFormRow className="flex items-center justify-between gap-4 space-y-0">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.user')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          className="h-8 w-64"
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                    </SettingsFormRow>
                  )}
                />
                <FormField
                  control={form.control}
                  name="proxy.password"
                  render={({ field }) => (
                    <SettingsFormRow className="flex items-center justify-between gap-4 space-y-0">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.password')}
                      </FormLabel>

                      <InputGroup className="w-64">
                        <FormControl>
                          <InputGroupInput
                            {...field}
                            type={revealPassword ? 'text' : 'password'}
                            value={field.value}
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t(
                              revealPassword
                                ? 'settings.network.proxy.hidePassword'
                                : 'settings.network.proxy.showPassword'
                            )}
                            onClick={() => setRevealPassword((v) => !v)}
                          >
                            {revealPassword ? <ConcealIcon /> : <RevealIcon />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </SettingsFormRow>
                  )}
                />
              </div>
            )}
          </div>

          {/* Keep the selected uses visible; edit them in a persistent checkbox menu. */}
          <FormField
            control={form.control}
            name="proxy.scopes"
            render={({ field }) => {
              const selected = PROXY_SCOPES.filter((scope) => scopes[scope])
              const summary =
                selected.length === 0
                  ? t('settings.network.proxy.scopeNone')
                  : selected
                      .map((scope) => scopeLabels[scope])
                      .join(t('settings.network.proxy.scopeSeparator'))
              return (
                <SettingsFormRow>
                  <div className="min-w-0 space-y-1">
                    <FormLabel>{t('settings.network.proxy.scopes')}</FormLabel>
                    <FormDescription className="text-xs">
                      {summary}
                    </FormDescription>
                  </div>
                  <DropdownMenu>
                    <FormControl>
                      <DropdownMenuTrigger
                        aria-label={t('settings.network.proxy.scopes')}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-w-30 shrink-0 justify-between gap-2 font-normal"
                          />
                        }
                      >
                        {t('settings.network.proxy.scopeChoose')}
                        <ChevronDownIcon className="size-4 text-muted-foreground" />
                      </DropdownMenuTrigger>
                    </FormControl>
                    <DropdownMenuContent
                      align="end"
                      className="w-64 max-w-[calc(100vw-2rem)]"
                    >
                      {PROXY_SCOPES.map((scope) => (
                        <DropdownMenuCheckboxItem
                          key={scope}
                          checked={scopes[scope]}
                          closeOnClick={false}
                          onCheckedChange={(checked) =>
                            form.setValue(`proxy.scopes.${scope}`, checked, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                          className="[&>span]:size-4 [&>span]:rounded-[4px] [&>span]:border [&>span]:border-input data-checked:[&>span]:border-primary data-checked:[&>span]:bg-primary data-checked:[&>span]:text-primary-foreground"
                        >
                          {scopeLabels[scope]}
                        </DropdownMenuCheckboxItem>
                      ))}
                      <DropdownMenuSeparator />
                      <p className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                        {t('settings.network.proxy.scopeHint')}
                      </p>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SettingsFormRow>
              )
            }}
          />

          {/* Bypass — scope effect inlined in the title row */}
          <FormField
            control={form.control}
            name="proxy.bypass"
            render={({ field, fieldState }) => (
              <FormItem className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <FormLabel>{t('settings.network.proxy.bypass')}</FormLabel>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.network.proxy.bypassScopeNote')}
                  </span>
                </div>
                <FormControl>
                  <Textarea
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    className="min-h-20 text-xs"
                    placeholder={t('settings.network.proxy.bypassPlaceholder')}
                    value={(field.value ?? []).join('\n')}
                    onChange={(e) => {
                      const lines = e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0)
                      field.onChange(lines)
                    }}
                  />
                </FormControl>
                <FormDescription className="text-xs">
                  {t('settings.network.proxy.bypassDesc')}
                </FormDescription>
                <FormMessage className="basis-full text-xs">
                  {Array.isArray(fieldState.error)
                    ? fieldState.error.find((error) => error?.message)?.message
                    : undefined}
                </FormMessage>
              </FormItem>
            )}
          />
        </div>
      )}
    </>
  )
}
