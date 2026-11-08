import { ChevronDownIcon, InfoIcon } from '@renderer/components/icons'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import type { ConsentPayload } from '@shared/types/plugin-install'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { GrantsMap } from '../lib/audience'
import { BroadHostAccessWarning } from './broad-host-access-warning'
import { ConsentDiffSection } from './consent-diff-section'
import { PermissionRow } from './permission-row'

interface Props {
  consent: ConsentPayload
  grants: GrantsMap
  onGrantsChange: (next: GrantsMap) => void
  disabled?: boolean
}

const groupClass = 'divide-y overflow-hidden rounded-lg border bg-muted/40'
const disclosureClass =
  'group inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring'

export function InlineConsentPanel({
  consent,
  grants,
  onGrantsChange,
  disabled,
}: Props) {
  const { t } = useTranslation()
  const requiredTitle = useId()
  const optionalTitle = useId()
  const {
    permissions,
    optionalPermissions,
    hostPermissions,
    invokesCommands,
    publicCommandsExposed,
  } = consent.trustSurface
  const broad = hostPermissions.some((h) => h.broad)
  const hosts = hostPermissions.length > 0 && (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className={disclosureClass} disabled={disabled}>
        {t('plugins.consent.hostPermissions')}
        <ChevronDownIcon className="size-3.5 transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 space-y-1.5 border-s-2 ps-3">
          {hostPermissions.map((h) => (
            <code
              key={h.pattern}
              className="block break-all text-xs leading-5 text-muted-foreground"
            >
              {h.pattern}
            </code>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
  const hostPermission = permissions.find(
    (p) => p.name === 'http' || p.name === 'network'
  )?.name

  return (
    <div className="space-y-5">
      {broad && <BroadHostAccessWarning />}
      {consent.diff && <ConsentDiffSection diff={consent.diff} />}
      {permissions.length > 0 && (
        <section aria-labelledby={requiredTitle}>
          <h3 id={requiredTitle} className="mb-2 text-xs font-semibold">
            {t('plugins.consent.permissions')}
          </h3>
          <div className={groupClass}>
            {permissions.map((p) => (
              <PermissionRow key={p.name} permission={p.name} granted grouped>
                {p.name === hostPermission ? hosts : null}
              </PermissionRow>
            ))}
          </div>
        </section>
      )}
      {!hostPermission && hosts}
      {optionalPermissions.length > 0 && (
        <section aria-labelledby={optionalTitle}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 id={optionalTitle} className="text-xs font-semibold">
              {t('plugins.consent.optionalPermissions')}
            </h3>
            <span className="text-xs text-muted-foreground">
              {t('plugins.install.optionalHint')}
            </span>
          </div>
          <div className={groupClass}>
            {optionalPermissions.map((p) => (
              <PermissionRow
                key={p.name}
                permission={p.name}
                granted={grants[p.name] === 'granted'}
                disabled={disabled}
                grouped
                onToggle={() => {
                  if (!disabled)
                    onGrantsChange({
                      ...grants,
                      [p.name]:
                        grants[p.name] === 'granted' ? 'denied' : 'granted',
                    })
                }}
              />
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('plugins.install.optionalLater')}
          </p>
        </section>
      )}
      {permissions.length === 0 &&
        optionalPermissions.length === 0 &&
        hostPermissions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('plugins.permissions.empty')}
          </p>
        )}
      {invokesCommands.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold">
            {t('plugins.consent.invokesCommands')}
          </h3>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {invokesCommands.map((command) => (
              <li key={command.commandId} className="break-all">
                <code>{command.commandId}</code>
                {!command.calleeInstalled &&
                  ` · ${t('plugins.consent.calleeMissing')}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Collapsible className="border-t pt-4">
        <CollapsibleTrigger className={disclosureClass} disabled={disabled}>
          {t('plugins.card.advancedDetails')}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <p className="break-all">
              {t('plugins.consent.source', {
                type: consent.source.type,
                url: consent.source.url,
              })}
            </p>
            <code className="block break-all">{consent.manifest.id}</code>
            <code className="block break-all">
              SHA-256: {consent.source.bundleSha256}
            </code>
            <p>
              {t('plugins.registry.requires', {
                range: consent.trustSurface.enginesMotrix,
              })}
            </p>
            {consent.trustSurface.requestedHeapMB != null && (
              <p>
                {t('plugins.consent.diff.heap')}:{' '}
                {consent.trustSurface.requestedHeapMB} {t('units.bytes.mb')}
              </p>
            )}
            {publicCommandsExposed.length > 0 && (
              <div>
                <p>{t('plugins.consent.diff.publicCommands')}</p>
                {publicCommandsExposed.map((command) => (
                  <code className="block break-all" key={command.id}>
                    {command.id} · {command.title}
                  </code>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
        {t(
          consent.trustSurface.notVerified
            ? 'plugins.consent.notVerified'
            : 'plugins.install.officialVerified'
        )}
      </p>
    </div>
  )
}
