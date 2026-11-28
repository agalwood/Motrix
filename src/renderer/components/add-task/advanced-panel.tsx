import { AddIcon, HelpIcon, RemoveIcon } from '@renderer/components/icons'
import { TaskFormAdvanced } from '@renderer/components/task-form-layout'
import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS } from '@shared/external-urls'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  useFieldArray,
  useFormContext,
  useFormState,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAddTaskLayoutChange } from './add-task-layout-context'

export function AdvancedPanel({
  defaultOpen = false,
}: {
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const onLayoutChange = useAddTaskLayoutChange()
  const { control, getValues, getFieldState, setFocus } =
    useFormContext<AddTaskFormValues>()
  const { submitCount } = useFormState({ control })
  const lastSubmit = useRef(submitCount)
  const pendingFocus = useRef<number | null>(null)
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  const requestOptions = useWatch<AddTaskFormValues, 'legacyRequestOptions'>({
    name: 'legacyRequestOptions',
  })

  useEffect(() => {
    if (lastSubmit.current === submitCount) return
    lastSubmit.current = submitCount
    if (open || tab !== 'links') return
    const index = (getValues('extraHeaders') ?? []).findIndex(
      (_, i) => getFieldState(`extraHeaders.${i}.name`).invalid
    )
    if (index < 0) return
    pendingFocus.current = index
    setOpen(true)
  }, [submitCount, open, tab, getValues, getFieldState])
  useEffect(() => {
    if (open && pendingFocus.current !== null) {
      setFocus(`extraHeaders.${pendingFocus.current}.name`)
      pendingFocus.current = null
    }
  }, [open, setFocus])

  useLayoutEffect(() => {
    if (tab === 'links' && requestOptions !== undefined) setOpen(true)
  }, [requestOptions, tab])

  useLayoutEffect(() => {
    onLayoutChange?.(open)
  }, [onLayoutChange, open])

  return (
    <TaskFormAdvanced open={open} onOpenChange={setOpen}>
      {tab === 'links' ? <LinksAdvancedFields /> : <TorrentAdvancedFields />}
    </TaskFormAdvanced>
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
      <ExtraHeadersFields />
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
              <HelpIcon className="size-4 hover:text-foreground" />
            </a>
          </>
        }
        placeholder="[http://][USER:PASSWORD@]HOST[:PORT]"
      />
    </>
  )
}

function ExtraHeadersFields() {
  const { t } = useTranslation()
  const labelId = useId()
  const errorId = useId()
  const { control, getFieldState, getValues, setFocus } =
    useFormContext<AddTaskFormValues>()
  const state = useFormState({ control, name: 'extraHeaders' })
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'extraHeaders',
  })
  const hasNameError = fields.some(
    (_, index) => getFieldState(`extraHeaders.${index}.name`, state).invalid
  )
  const addHeader = () => {
    const rows = getValues('extraHeaders') ?? []
    const unnamed = rows.findIndex((row) => !row.name.trim())
    if (unnamed !== -1) {
      setFocus(`extraHeaders.${unnamed}.name`)
      return
    }
    append(
      { name: '', value: '' },
      { focusName: `extraHeaders.${rows.length}.name` }
    )
  }
  return (
    <fieldset
      aria-labelledby={labelId}
      className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-start gap-3"
    >
      <span
        id={labelId}
        className="pt-2 text-xs leading-4 text-muted-foreground"
      >
        {t('task.add.extraHeaders')}
      </span>
      <div className="@container/headers flex min-h-8 min-w-0 flex-col justify-center gap-1.5">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_1.5rem] items-start gap-x-2 gap-y-1 @min-[16rem]/headers:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_1.5rem]"
          >
            <FormField
              control={control}
              name={`extraHeaders.${index}.name`}
              render={({ field: nameField, fieldState }) => (
                <FormItem className="min-w-0">
                  <FormLabel className="sr-only">
                    {t('task.add.headerName')}
                  </FormLabel>
                  <FormControl
                    aria-describedby={fieldState.invalid ? errorId : undefined}
                  >
                    <Input
                      {...nameField}
                      placeholder={t('task.add.headerName')}
                      className="h-8 text-xs"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`extraHeaders.${index}.value`}
              rules={{ deps: `extraHeaders.${index}.name` }}
              render={({ field: valueField }) => (
                <FormItem className="col-start-1 row-start-2 min-w-0 @min-[16rem]/headers:col-start-2 @min-[16rem]/headers:row-start-1">
                  <FormLabel className="sr-only">
                    {t('task.add.headerValue')}
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...valueField}
                      placeholder={t('task.add.headerValue')}
                      className="h-8 text-xs"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="col-start-2 row-start-1 mt-1 text-muted-foreground hover:text-foreground @min-[16rem]/headers:col-start-3"
              aria-label={t('task.add.removeHeader')}
              onClick={() => remove(index)}
            >
              <RemoveIcon aria-hidden="true" />
            </Button>
          </div>
        ))}
        {hasNameError && (
          <p
            id={errorId}
            role="alert"
            className="text-xs leading-4 text-destructive"
          >
            {t('task.add.errors.headerNameRequired')}
          </p>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="-ms-1.5 self-start font-normal text-muted-foreground hover:text-foreground"
          onClick={addHeader}
        >
          <AddIcon aria-hidden="true" className="size-3.5" />
          {t('task.add.addHeader')}
        </Button>
      </div>
    </fieldset>
  )
}

function TorrentAdvancedFields() {
  const { unitSystem, formatByteUnit } = useByteFormat()
  const scale = unitSystem === 'binary' ? 1024 : 1000
  const unit = formatByteUnit(unitSystem === 'binary' ? 'KiB' : 'KB', true)
  const { t } = useTranslation()
  const { control } = useFormContext<AddTaskFormValues>()
  return (
    <>
      <DenseField
        control={control}
        name="dlLimit"
        label={
          <>
            {t('task.add.dlLimit')} ({unit})
          </>
        }
        type="number"
        min={0}
        scale={scale}
        step="any"
        placeholder={t('task.add.unlimited')}
      />
      <DenseField
        control={control}
        name="ulLimit"
        label={
          <>
            {t('task.add.ulLimit')} ({unit})
          </>
        }
        type="number"
        min={0}
        scale={scale}
        step="any"
        placeholder={t('task.add.unlimited')}
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
  scale?: number
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
  scale = 1,
}: DenseFieldProps) {
  const [draft, setDraft] = useState<{ text: string; scale: number } | null>(
    null
  )
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
                  draft?.scale === scale
                    ? draft.text
                    : typeof field.value === 'number'
                      ? field.value / scale
                      : typeof field.value === 'string'
                        ? field.value
                        : ''
                }
                onChange={(e) => {
                  if (type === 'number') {
                    const v = e.target.value
                    if (scale !== 1) setDraft({ text: v, scale })
                    field.onChange(
                      v === ''
                        ? undefined
                        : scale === 1
                          ? Number(v)
                          : Math.round(Number(v) * scale)
                    )
                  } else {
                    field.onChange(e.target.value)
                  }
                }}
                onBlur={() => {
                  setDraft(null)
                  field.onBlur()
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
