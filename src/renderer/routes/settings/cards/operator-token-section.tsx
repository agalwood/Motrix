import { zodResolver } from '@hookform/resolvers/zod'
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { PasswordInput } from '@renderer/components/ui/password-input'
import { Separator } from '@renderer/components/ui/separator'
import {
  changeOperatorToken,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import {
  changeOperatorTokenSchema,
  isWeakOperatorToken,
} from '@shared/schemas/operator-token'
import { useEffect, useId, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

const schema = changeOperatorTokenSchema
  .extend({
    currentToken: z.string().min(1).max(4096),
    confirmation: z.string(),
  })
  .refine((value) => value.newToken === value.confirmation, {
    path: ['confirmation'],
  })
type Fields = z.infer<typeof schema>

export function OperatorTokenSection() {
  const [editing, onEditingChange] = useState(false)
  const { t } = useTranslation()
  const source = useOperatorSession((state) => state.status?.tokenSource)
  const [saved, setSaved] = useState(false)
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(editing)
  useEffect(() => {
    if (wasEditing.current && !editing) trigger.current?.focus()
    wasEditing.current = editing
  }, [editing])
  if (!source) return null
  return (
    <>
      <Separator className="my-4" />
      <section aria-labelledby={titleId}>
        <div className="flex items-center justify-between gap-4">
          <h3 id={titleId} className="text-sm font-semibold">
            {t('operatorToken.title')}
          </h3>
          {source === 'file' && (
            <Button
              ref={trigger}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSaved(false)
                onEditingChange(true)
              }}
            >
              {t('operatorToken.change')}
            </Button>
          )}
        </div>
        {source === 'env' && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('operatorToken.managed')}
          </p>
        )}
        {saved && (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {t('operatorToken.saved')}
          </p>
        )}
        {editing && source === 'file' && (
          <TokenDialog
            onClose={() => onEditingChange(false)}
            onSaved={() => {
              setSaved(true)
              onEditingChange(false)
            }}
          />
        )}
      </section>
    </>
  )
}

function TokenDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const form = useForm<Fields>({
    resolver: async (values, context, options) => {
      const result = await zodResolver(schema)(values, context, options)
      for (const name of [
        'currentToken',
        'newToken',
        'confirmation',
      ] as const) {
        const error = result.errors[name]
        if (error) {
          const key =
            name === 'confirmation'
              ? 'mismatch'
              : values[name].trim().length === 0
                ? name === 'currentToken'
                  ? 'requiredCurrent'
                  : 'requiredNew'
                : values[name].length > 1024
                  ? 'tooLong'
                  : 'invalid'
          error.message = t(`operatorToken.${key}`)
        }
      }
      return result
    },
    defaultValues: { currentToken: '', newToken: '', confirmation: '' },
  })
  const newToken = form.watch('newToken')
  const weak = touched && newToken.length > 0 && isWeakOperatorToken(newToken)
  const busy = form.formState.isSubmitting
  const submit = form.handleSubmit(async ({ currentToken, newToken: next }) => {
    setError(null)
    try {
      const result = await changeOperatorToken(currentToken, next)
      if (result.ok) {
        form.reset()
        onSaved()
      } else setError(result.reason)
    } catch {
      setError('unknown')
    }
  })
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next) {
          if (busy) details.cancel()
          else onClose()
        }
      }}
    >
      <DialogContent
        forceRenderOverlay
        showCloseButton={!busy}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t('operatorToken.change')}</DialogTitle>
          <DialogDescription>{t('operatorToken.effect')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className="space-y-3 overflow-y-auto px-6 py-4">
              <input
                type="hidden"
                name="username"
                autoComplete="username"
                value="operator"
              />
              {(['currentToken', 'newToken', 'confirmation'] as const).map(
                (name) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field, fieldState }) => (
                      <FormItem>
                        <FormLabel>{t(`operatorToken.${name}`)}</FormLabel>
                        <FormControl>
                          <PasswordInput
                            {...field}
                            disabled={busy}
                            onBlur={() => {
                              field.onBlur()
                              if (name === 'newToken') setTouched(true)
                            }}
                            autoComplete={
                              name === 'currentToken'
                                ? 'current-password'
                                : 'new-password'
                            }
                            showPasswordLabel={t('common.showPassword')}
                            hidePasswordLabel={t('common.hidePassword')}
                            aria-describedby={
                              name === 'newToken' && weak
                                ? `${id}-hint`
                                : undefined
                            }
                          />
                        </FormControl>
                        {name === 'newToken' && weak && (
                          <p
                            id={`${id}-hint`}
                            className="text-xs text-muted-foreground"
                            aria-live="polite"
                          >
                            {t('operatorToken.weak')}
                          </p>
                        )}
                        {fieldState.error && <FormMessage />}
                      </FormItem>
                    )}
                  />
                )
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {t(`operatorToken.${error}`)}
                </p>
              )}
            </div>
            <DialogFooter className="shrink-0 border-t px-6 py-4">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {t(busy ? 'operatorToken.saving' : 'operatorToken.update')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
