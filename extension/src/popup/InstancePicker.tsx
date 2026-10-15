import { LaptopIcon, RefreshCwIcon } from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { PairCandidate } from '@/background/ConnectionManager'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'

export interface InstancePickerProps {
  candidates: PairCandidate[]
  onChoose: (port: number) => void
  onRescan: () => void
  /** Disables every row and the rescan button — e.g. a choice is already
   *  in flight. */
  disabled?: boolean
  rescanning?: boolean
}

/** A candidate's §4.1 `instanceId` is at most 128 ASCII chars (per
 *  discovery-service.ts's own bound) — this is purely a display trim so one
 *  long value can't push the port/version columns off a narrow popup. */
function shortInstanceId(instanceId: string | null): string {
  if (instanceId === null) return '—'
  return instanceId.length > 12 ? `${instanceId.slice(0, 12)}…` : instanceId
}

export function InstancePicker({
  candidates,
  onChoose,
  onRescan,
  disabled,
  rescanning,
}: InstancePickerProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {/* "Multiple instances found — pick one" is only true with 2+ rows;
            with 0 the empty state below speaks, with 1 the row speaks. */}
        {candidates.length > 1 && (
          <p className="text-sm text-muted-foreground">
            {t('popup.pairing.pickerHelp')}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ms-auto"
          disabled={disabled || rescanning}
          onClick={onRescan}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={rescanning ? 'animate-spin' : undefined}
          />
          {t('popup.pairing.rescan')}
        </Button>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('popup.pairing.noCandidates')}
        </p>
      ) : (
        <ItemGroup aria-label={t('popup.pairing.candidatesLabel')}>
          {candidates.map((candidate) => (
            <Item
              key={candidate.port}
              role="listitem"
              variant="outline"
              size="sm"
            >
              <ItemMedia variant="icon">
                <LaptopIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {t('popup.pairing.candidatePort', { port: candidate.port })}
                </ItemTitle>
                <ItemDescription>
                  {t('popup.pairing.candidateDetail', {
                    instanceId: shortInstanceId(candidate.instanceId),
                    appVersion:
                      candidate.appVersion ?? t('popup.pairing.unknownVersion'),
                  })}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onChoose(candidate.port)}
                >
                  {t('popup.pairing.choose')}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  )
}
