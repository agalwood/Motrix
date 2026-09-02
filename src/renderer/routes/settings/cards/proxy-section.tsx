import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
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
import { ChevronDown, Eye, EyeOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { NetworkFields } from './network-dialog'

export function ProxySection({ form }: { form: UseFormReturn<NetworkFields> }) {
  const { t } = useTranslation()

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
    form.setValue('proxy.protocol', protocol, { shouldDirty: true })
  }

  const handleAuthToggle = (checked: boolean) => {
    setShowAuth(checked)
    if (!checked) {
      form.setValue('proxy.user', '', { shouldDirty: true })
      form.setValue('proxy.password', '', { shouldDirty: true })
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
    form.setValue('proxy.host', detected.host, { shouldDirty: true })
    form.setValue('proxy.port', detected.port, { shouldDirty: true })
    form.setValue('proxy.user', detected.user ?? '', { shouldDirty: true })
    form.setValue('proxy.password', detected.password ?? '', {
      shouldDirty: true,
    })
    form.setValue('proxy.bypass', detected.bypass ?? [], { shouldDirty: true })
    const hasAuth = Boolean(detected.user || detected.password)
    setShowAuth(hasAuth)
    seededRef.current = hasAuth
    if (!hasAuth) setRevealPassword(false)
    // Importing implies the user wants to USE this proxy; flip the master
    // toggle on so the rest of the form reveals.
    if (!form.getValues('proxy.enabled')) {
      form.setValue('proxy.enabled', true, { shouldDirty: true })
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
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>{t('settings.network.proxy.enable')}</FormLabel>
              <FormDescription className="text-xs">
                {t('settings.network.proxy.enableDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      {/* Body — only when proxy is enabled */}
      {proxyEnabled && (
        <div className="space-y-4 border-l border-border/60 pl-4">
          {/* Server: protocol + host as one InputGroup, port adjacent */}
          <div className="space-y-1.5">
            <FormLabel>{t('settings.network.proxy.server')}</FormLabel>
            <div className="flex items-start gap-2">
              <FormField
                control={form.control}
                name="proxy.host"
                render={({ field }) => (
                  <FormItem className="flex-1 space-y-0">
                    <FormControl>
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
                                  <ChevronDown />
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
                        <InputGroupInput
                          placeholder={t(
                            'settings.network.proxy.hostPlaceholder'
                          )}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </InputGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="proxy.port"
                render={({ field }) => (
                  <FormItem className="w-30 space-y-0">
                    <FormControl>
                      <InputGroup className="h-8">
                        <InputGroupAddon align="inline-start">
                          <InputGroupText>:</InputGroupText>
                        </InputGroupAddon>
                        <InputGroupInput
                          type="number"
                          min={1}
                          max={65535}
                          value={field.value}
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value, 10)
                            field.onChange(Number.isFinite(n) ? n : 8080)
                          }}
                        />
                      </InputGroup>
                    </FormControl>
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
              <Switch checked={showAuth} onCheckedChange={handleAuthToggle} />
            </div>
            {showAuth && (
              <div className="space-y-2 pt-1">
                <FormField
                  control={form.control}
                  name="proxy.user"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4 space-y-0">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.user')}
                      </FormLabel>
                      <FormControl>
                        <Input
                          className="h-8 w-64"
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="proxy.password"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4 space-y-0">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.password')}
                      </FormLabel>
                      <FormControl>
                        <InputGroup className="w-64">
                          <InputGroupInput
                            type={revealPassword ? 'text' : 'password'}
                            value={field.value}
                            onChange={field.onChange}
                          />
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
                              {revealPassword ? <EyeOff /> : <Eye />}
                            </InputGroupButton>
                          </InputGroupAddon>
                        </InputGroup>
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            )}
          </div>

          {/* Scopes — bg-muted/20 grouped card; each row carries
              a description so users understand what the toggle
              actually does. */}
          <div className="space-y-2">
            <div className="space-y-1">
              <p className="text-sm font-medium leading-none">
                {t('settings.network.proxy.scopes')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('settings.network.proxy.scopesDesc')}
              </p>
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-muted/20">
              <FormField
                control={form.control}
                name="proxy.scopes.download"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4 space-y-0 px-3 py-2.5">
                    <div className="space-y-0.5">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.scopeDownload')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.network.proxy.scopeDownloadDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="proxy.scopes.updateApp"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4 space-y-0 px-3 py-2.5">
                    <div className="space-y-0.5">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.scopeUpdateApp')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.network.proxy.scopeUpdateAppDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="proxy.scopes.updateTrackers"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4 space-y-0 px-3 py-2.5">
                    <div className="space-y-0.5">
                      <FormLabel className="font-normal">
                        {t('settings.network.proxy.scopeUpdateTrackers')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.network.proxy.scopeUpdateTrackersDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </div>

          {/* Bypass — scope effect inlined in the title row */}
          <FormField
            control={form.control}
            name="proxy.bypass"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <FormLabel>{t('settings.network.proxy.bypass')}</FormLabel>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.network.proxy.bypassScopeNote')}
                  </span>
                </div>
                <FormControl>
                  <Textarea
                    className="min-h-20 text-xs"
                    placeholder={'localhost\n127.0.0.1\n*.local'}
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
              </FormItem>
            )}
          />
        </div>
      )}
    </>
  )
}
