import { EndpointList } from '@renderer/components/settings-kit/endpoint-list'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_NAT_SETTINGS,
  DEFAULT_PROXY_SETTINGS,
} from '@shared/schemas'
import type {
  AppSettings,
  DnsResolutionMode,
  NatSettings,
  ProxySettings,
} from '@shared/types/settings'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { SettingsCardDialogProps } from './card-types'
import { ProxySection } from './proxy-section'

export interface NetworkFields {
  proxy: ProxySettings
  nat: NatSettings
  // Only the DNS slice of EngineSettings is edited here; the rest of the
  // engine namespace stays with the Downloads dialog.
  engine: { dnsMode: DnsResolutionMode }
}

// Source of truth: src/shared/schemas/{proxy,nat,engine}-settings.ts.
// Keep in sync with the corresponding DEFAULT_* exports.
const DEFAULTS: NetworkFields = {
  proxy: { ...DEFAULT_PROXY_SETTINGS },
  nat: { ...DEFAULT_NAT_SETTINGS },
  engine: { dnsMode: DEFAULT_ENGINE_SETTINGS.dnsMode },
}

const NAT_PROTOCOL_OPTIONS = [
  { label: 'auto', value: 'auto' },
  { label: 'pcp', value: 'pcp' },
  { label: 'natpmp', value: 'natpmp' },
  { label: 'upnp', value: 'upnp' },
] as const satisfies ReadonlyArray<{
  label: string
  value: NatSettings['preferredProtocol']
}>

const stunSchema = z
  .string()
  .regex(/^[a-z0-9.-]+:\d+$/i, 'invalid host:port')
  .max(253)

const reachabilitySchema = z
  .string()
  .url()
  .startsWith('https://', 'must be HTTPS')

export function NetworkDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const form = useForm<NetworkFields>({ defaultValues: DEFAULTS })

  const dnsModeOptions = [
    { value: 'auto', label: t('settings.network.dns.modeAuto') },
    { value: 'system', label: t('settings.network.dns.modeSystem') },
    { value: 'engine', label: t('settings.network.dns.modeEngine') },
  ] as const

  // biome-ignore lint/correctness/useExhaustiveDependencies: form is stable
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings | undefined
        if (all?.proxy && all?.nat) {
          form.reset({
            proxy: all.proxy,
            nat: all.nat,
            engine: {
              dnsMode: all.engine?.dnsMode ?? DEFAULT_ENGINE_SETTINGS.dnsMode,
            },
          })
        }
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = form.handleSubmit(async (values) => {
    // biome-ignore lint/suspicious/noExplicitAny: dirtyFields shape doesn't fit DirtyTree; cast is safe
    const dirty = pickDirty(values, form.formState.dirtyFields as any)
    if (!dirty) {
      onClose()
      return
    }
    await transport.invoke(Commands.UpdateSettings, dirty)
    onClose()
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <Form {...form}>
            <form className="space-y-4">
              <ProxySection form={form} />

              <Separator className="my-4" />

              {/* DNS resolution */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.network.dns.title')}
              </h3>
              <FormField
                control={form.control}
                name="engine.dnsMode"
                render={({ field }) => (
                  <FormItem className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <FormLabel>{t('settings.network.dns.mode')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.network.dns.modeDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Select
                        items={dnsModeOptions}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value !== null) field.onChange(value)
                        }}
                      >
                        <SettingsSelectTrigger>
                          <SelectValue />
                        </SettingsSelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {dnsModeOptions.map(({ label, value }) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />

              <Separator className="my-4" />

              {/* NAT mapping */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.network.nat.title')}
              </h3>

              <FormField
                control={form.control}
                name="nat.enabled"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>{t('settings.network.nat.enable')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.network.nat.enableDesc')}
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
                name="nat.preferredProtocol"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>
                      {t('settings.network.nat.preferredProtocol')}
                    </FormLabel>
                    <FormControl>
                      <Select
                        items={NAT_PROTOCOL_OPTIONS}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value !== null) field.onChange(value)
                        }}
                      >
                        <SelectTrigger className="w-30" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {NAT_PROTOCOL_OPTIONS.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="nat.mappingTtl"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>
                      {t('settings.network.nat.mappingTtl')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1200}
                        max={7200}
                        className="w-30 h-8"
                        value={field.value}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10)
                          field.onChange(Number.isFinite(n) ? n : 7200)
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <p className="text-xs text-muted-foreground">
                {t('settings.network.nat.btPortHint')}
              </p>

              <Separator className="my-4" />

              {/* NAT type detection (STUN) */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.network.stun.title')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('settings.network.stun.privacyHint')}
              </p>

              <FormField
                control={form.control}
                name="nat.natTypeDetectionEnabled"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>{t('settings.network.stun.enable')}</FormLabel>
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
                name="nat.stunServers"
                render={() => (
                  <FormItem className="space-y-2">
                    <FormLabel>{t('settings.network.stun.servers')}</FormLabel>
                    <EndpointList
                      name="nat.stunServers"
                      maxItems={10}
                      itemSchema={stunSchema}
                      placeholder="stun.example.com:3478"
                      i18nKeys={{
                        addButton: 'settings.network.stun.addServer',
                        empty: 'settings.network.stun.empty',
                      }}
                    />
                  </FormItem>
                )}
              />

              <Separator className="my-4" />

              {/* Port reachability */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.network.reachability.title')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('settings.network.reachability.privacyHint')}
              </p>

              <FormField
                control={form.control}
                name="nat.portReachabilityCheckEnabled"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>
                      {t('settings.network.reachability.enable')}
                    </FormLabel>
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
                name="nat.portCheckerEndpoints"
                render={() => (
                  <FormItem className="space-y-2">
                    <FormLabel>
                      {t('settings.network.reachability.endpoints')}
                    </FormLabel>
                    <EndpointList
                      name="nat.portCheckerEndpoints"
                      maxItems={5}
                      itemSchema={reachabilitySchema}
                      placeholder="https://example.com/check"
                      i18nKeys={{
                        addButton: 'settings.network.reachability.addEndpoint',
                        empty: 'settings.network.reachability.empty',
                      }}
                    />
                  </FormItem>
                )}
              />

              <Separator className="my-4" />

              {/* Auto diagnostic */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.network.diagnostic.title')}
              </h3>

              <FormField
                control={form.control}
                name="nat.autoDiagnostic"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>
                      {t('settings.network.diagnostic.enable')}
                    </FormLabel>
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
                name="nat.diagnosticIntervalSec"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>
                      {t('settings.network.diagnostic.interval')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={300}
                        max={86400}
                        className="w-30 h-8"
                        value={field.value}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10)
                          field.onChange(Number.isFinite(n) ? n : 3600)
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </form>
          </Form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={form.formState.isSubmitting}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
