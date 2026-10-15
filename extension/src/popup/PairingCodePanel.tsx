import { REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp'
import { KeyRoundIcon } from 'lucide-react'
import type * as React from 'react'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  normalizePairingCode,
  sanitizePairingCodeInput,
} from '@/background/mbp1/pairing-code'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@/components/ui/input-otp'

/** §7.1 codes are 8 symbols, displayed and entered as two groups of four. */
const CODE_LENGTH = 8
const SLOT_GROUPS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
] as const

/** Slot sizing per surface: the popup is compact; the options dialog has
 *  room to make the code the visual centerpiece. */
const SLOT_SIZE_CLASS = {
  sm: 'size-8 font-mono text-sm',
  lg: 'size-10 font-mono text-base',
} as const

export interface PairingCodePanelProps {
  /**
   * Called with the code after it passes §7.1 local normalization —
   * never with raw user input, and never when normalization fails. The
   * caller (bg.submitPairingCode) is the one thing that can actually
   * consume a §7.2 attempt, so a code that can't even be well-formed must
   * never reach it.
   */
  onSubmit: (code: string) => void
  /** 1-based current attempt and §6.5's ceiling, both read from the
   *  provider's own request rather than counted in this component — the
   *  flow, not the UI, owns what attempt this is. */
  run?: number
  maxRuns?: number
  /** The peer's last claim, forwarded for display only — §6.5 says show it,
   *  but nothing here may decide anything from it. */
  attemptsRemaining?: number | null
  /** Absolute deadline supplied by bg.getState. The UI derives its countdown
   *  from this timestamp so reopening or polling never restarts the timer. */
  deadlineMs?: number
  /** Disables the input/button — e.g. while a previous submission is still
   *  in flight. */
  disabled?: boolean
  /** Slot sizing: `sm` (default) fits the popup tile; `lg` suits the
   *  roomier options pairing dialog. */
  size?: keyof typeof SLOT_SIZE_CLASS
}

export function PairingCodePanel({
  onSubmit,
  run,
  maxRuns,
  attemptsRemaining,
  deadlineMs,
  disabled,
  size = 'sm',
}: PairingCodePanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (deadlineMs === undefined || deadlineMs <= Date.now()) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deadlineMs])

  const secondsLeft =
    deadlineMs === undefined
      ? null
      : Math.max(0, Math.ceil((deadlineMs - now) / 1000))
  const formattedTime =
    secondsLeft === null
      ? null
      : `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(
          secondsLeft % 60
        ).padStart(2, '0')}`

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalized = normalizePairingCode(value)
    if (normalized === null) {
      setHint(t('popup.pairing.codeInvalid'))
      return
    }
    setHint(null)
    onSubmit(normalized)
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        {(run !== undefined || formattedTime !== null) && (
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
            {run !== undefined && maxRuns !== undefined && (
              <span>{t('popup.pairing.attemptOf', { run, maxRuns })}</span>
            )}
            {run !== undefined && formattedTime !== null && (
              <span aria-hidden="true" className="text-border">
                ·
              </span>
            )}
            {formattedTime !== null && (
              <span className="tabular-nums">
                {t('popup.pairing.expiresIn', { time: formattedTime })}
              </span>
            )}
            {attemptsRemaining != null && (
              <span className="sr-only">
                {t('popup.pairing.attemptsRemaining', { attemptsRemaining })}
              </span>
            )}
          </p>
        )}
        <Field data-invalid={hint !== null}>
          <FieldLabel htmlFor="pairing-code-input" className="sr-only">
            {t('popup.pairing.codeLabel')}
          </FieldLabel>
          <InputOTP
            id="pairing-code-input"
            maxLength={CODE_LENGTH}
            pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
            // The display form is XXXX-XXXX, so a code copied from the
            // Motrix dialog carries a hyphen; the §7.1 module owns what
            // counts as noise, and `onChange` below owns the casing.
            pasteTransformer={sanitizePairingCodeInput}
            autoFocus
            disabled={disabled}
            value={value}
            onChange={(next) => {
              setValue(next.toUpperCase())
              setHint(null)
            }}
            containerClassName="justify-center"
            aria-invalid={hint !== null}
          >
            {SLOT_GROUPS.map((group, groupIndex) => (
              <Fragment key={group[0]}>
                {groupIndex > 0 && (
                  <InputOTPSeparator className="text-muted-foreground" />
                )}
                <InputOTPGroup>
                  {group.map((index) => (
                    <InputOTPSlot
                      key={index}
                      index={index}
                      className={SLOT_SIZE_CLASS[size]}
                      aria-invalid={hint !== null}
                    />
                  ))}
                </InputOTPGroup>
              </Fragment>
            ))}
          </InputOTP>
          <FieldDescription className="text-center">
            {t('popup.pairing.codeDescription')}
          </FieldDescription>
          <FieldError className="text-center">{hint}</FieldError>
          <Button
            type="submit"
            className="w-full"
            disabled={disabled || secondsLeft === 0}
          >
            <KeyRoundIcon data-icon="inline-start" />
            {t('popup.pairing.pairButton')}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
