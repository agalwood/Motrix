import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS } from '@shared/external-urls'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import { ChevronRight, CircleQuestionMark } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAddTaskLayoutChange } from './add-task-layout-context'

export function AdvancedPanel() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const onLayoutChange = useAddTaskLayoutChange()
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })

  useLayoutEffect(() => {
    onLayoutChange?.(open)
  }, [onLayoutChange, open])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          />
        }
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-150',
            open && 'rotate-90'
          )}
          aria-hidden="true"
        />
        {t('task.add.advanced')}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ml-1.5 space-y-2 border-l-2 border-border pl-3">
        {tab === 'links' ? <LinksAdvancedFields /> : <TorrentAdvancedFields />}
      </CollapsibleContent>
    </Collapsible>
  )
}

function LinksAdvancedFields() {
  const { t } = useTranslation()
  const { control } = useFormContext<AddTaskFormValues>()
  return (
    <>
      <DenseField
        control={control}
        name="filename"
        label={t('task.add.filename')}
        placeholder={t('task.add.filenameAuto')}
      />
      <DenseField
        control={control}
        name="split"
        label={t('task.add.split')}
        type="number"
        min={1}
        max={128}
      />
      <DenseField
        control={control}
        name="userAgent"
        label={t('task.add.userAgent')}
        multiline
      />
      <DenseField
        control={control}
        name="referer"
        label={t('task.add.referer')}
      />
      <DenseField
        control={control}
        name="cookie"
        label={t('task.add.cookie')}
        multiline
      />
      <DenseField
        control={control}
        name="authorization"
        label={t('task.add.authorization')}
      />
      <DenseField
        control={control}
        name="allProxy"
        label={
          <>
            {t('task.add.allProxy')}
            <a
              href={EXTERNAL_URLS.motrix.manual.advancedProxy}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CircleQuestionMark className="size-4 hover:text-foreground" />
            </a>
          </>
        }
        placeholder="[http://][USER:PASSWORD@]HOST[:PORT]"
      />
    </>
  )
}

function TorrentAdvancedFields() {
  const { t } = useTranslation()
  const { control } = useFormContext<AddTaskFormValues>()
  return (
    <>
      <DenseField
        control={control}
        name="dlLimit"
        label={t('task.add.dlLimit')}
        type="number"
        min={0}
        placeholder="KB/s"
      />
      <DenseField
        control={control}
        name="ulLimit"
        label={t('task.add.ulLimit')}
        type="number"
        min={0}
        placeholder="KB/s"
      />
      <DenseField
        control={control}
        name="seedRatio"
        label={t('task.add.seedRatio')}
        type="number"
        min={0}
        step="0.1"
        placeholder={t('task.add.unlimited')}
      />
    </>
  )
}

interface DenseFieldProps {
  // biome-ignore lint/suspicious/noExplicitAny: RHF Control generic is too narrow
  control: any
  name: string
  // Accepts any ReactNode so callers can compose e.g. `<>UA <CircleQuestionMark/></>`
  // for inline help affordances. Accessibility is handled by FormLabel's
  // htmlFor ↔ FormControl's id wiring in shadcn/ui's form primitive.
  label: ReactNode
  type?: string
  placeholder?: string
  min?: number
  max?: number
  step?: string
  multiline?: boolean
}

function DenseField({
  control,
  name,
  label,
  type,
  placeholder,
  min,
  max,
  step,
  multiline,
}: DenseFieldProps) {
  return (
    <FormField
      control={control}
      name={name as never}
      render={({ field }) => (
        <FormItem
          className={cn(
            'grid grid-cols-[5rem_1fr] gap-3 space-y-0',
            multiline ? 'items-start' : 'items-center'
          )}
        >
          <FormLabel
            className={cn(
              'text-xs font-normal text-muted-foreground',
              multiline && 'pt-1.5'
            )}
          >
            {label}
          </FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea
                {...field}
                placeholder={placeholder}
                value={typeof field.value === 'string' ? field.value : ''}
                onChange={(e) => field.onChange(e.target.value)}
                rows={2}
                className="min-h-14 max-h-18 resize-y py-1.5 font-mono text-xs leading-snug"
              />
            ) : (
              <Input
                {...field}
                type={type}
                min={min}
                max={max}
                step={step}
                placeholder={placeholder}
                value={
                  typeof field.value === 'number' ||
                  typeof field.value === 'string'
                    ? field.value
                    : ''
                }
                onChange={(e) => {
                  if (type === 'number') {
                    const v = e.target.value
                    field.onChange(v === '' ? undefined : Number(v))
                  } else {
                    field.onChange(e.target.value)
                  }
                }}
                className="h-8 text-xs"
              />
            )}
          </FormControl>
        </FormItem>
      )}
    />
  )
}
