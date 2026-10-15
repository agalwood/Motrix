import { CircleAlertIcon } from 'lucide-react'
import type * as React from 'react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { MotrixServerEndpoint } from '@/background/EndpointConfigStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { type ServerFormValues, serverFormSchema } from '@/options/tabs/schemas'
import { zodFormResolver } from '@/options/zodFormResolver'

interface ServerEditorDialogProps {
  open: boolean
  server: MotrixServerEndpoint | null
  onOpenChange: (open: boolean) => void
  onSave: (values: ServerFormValues) => Promise<void>
}

export function ServerEditorDialog({
  open,
  server,
  onOpenChange,
  onSave,
}: ServerEditorDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const form = useForm<ServerFormValues>({
    resolver: zodFormResolver(serverFormSchema),
    defaultValues: { name: '', url: '' },
  })
  const configuredUrl = form.watch('url')
  const usesPlainWebSocket = configuredUrl.toLowerCase().startsWith('ws://')

  useEffect(() => {
    if (!open) return
    form.reset({
      name: server?.name ?? '',
      url: server?.url ?? '',
    })
  }, [form, open, server])

  const handleSubmit = async (values: ServerFormValues): Promise<void> => {
    try {
      await onSave(values)
      onOpenChange(false)
    } catch {
      // The parent surfaces the actionable error at the top of the panel.
      // Keeping the dialog open preserves the user's input so they can
      // correct and retry.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {server === null
              ? t('options.servers.addTitle')
              : t('options.servers.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('options.servers.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          id="motrix-server-form"
          onSubmit={form.handleSubmit(handleSubmit)}
        >
          <FieldGroup>
            <Field data-invalid={form.formState.errors.name !== undefined}>
              <FieldLabel htmlFor="motrix-server-name">
                {t('options.servers.nameLabel')}
              </FieldLabel>
              <Input
                id="motrix-server-name"
                autoComplete="off"
                placeholder={t('options.servers.namePlaceholder')}
                aria-invalid={form.formState.errors.name !== undefined}
                {...form.register('name')}
              />
              <FieldError>
                {form.formState.errors.name?.message === undefined
                  ? null
                  : t(form.formState.errors.name.message)}
              </FieldError>
            </Field>
            <Field data-invalid={form.formState.errors.url !== undefined}>
              <FieldLabel htmlFor="motrix-server-url">
                {t('options.servers.urlLabel')}
              </FieldLabel>
              <Input
                id="motrix-server-url"
                dir="ltr"
                autoComplete="url"
                inputMode="url"
                placeholder={t('options.servers.urlPlaceholder')}
                aria-invalid={form.formState.errors.url !== undefined}
                {...form.register('url')}
              />
              <FieldDescription>
                {t('options.servers.urlDescription')}
              </FieldDescription>
              <FieldError>
                {form.formState.errors.url?.message === undefined
                  ? null
                  : t(form.formState.errors.url.message)}
              </FieldError>
            </Field>
            {usesPlainWebSocket && (
              <Alert aria-label={t('options.servers.transportWarningTitle')}>
                <CircleAlertIcon />
                <AlertTitle>
                  {t('options.servers.transportWarningTitle')}
                </AlertTitle>
                <AlertDescription>
                  {t('options.servers.transportWarningBody')}
                </AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('options.common.cancel')}
          </DialogClose>
          <Button
            type="submit"
            form="motrix-server-form"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && (
              <Spinner data-icon="inline-start" />
            )}
            {t('options.servers.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
