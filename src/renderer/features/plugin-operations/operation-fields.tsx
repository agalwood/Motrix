import {
  matchesOperationCondition,
  type OperationLayout,
} from '@motrix/plugin-manifest-schema'
import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { ChevronDownIcon } from '@renderer/components/icons'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@renderer/components/ui/toggle-group'
import type {
  OperationDescriptor,
  OperationDraft,
} from '@shared/schemas/plugin-operations'
import { useId } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { fieldTones, OperationFieldIcon } from './operation-icon'

type Value = string | number | boolean
interface Props {
  descriptor: OperationDescriptor
  draft?: OperationDraft
  blocked: boolean
  pick(field: string): Promise<string | null>
  drop(field: string, path: string): Promise<string | null>
  change(field: string, value: Value): void
  onPending(pending: boolean): void
  onError(error: unknown): void
}
export function OperationFields({
  descriptor,
  draft,
  blocked,
  pick,
  drop,
  change,
  onPending,
  onError,
}: Props) {
  const id = useId()
  const { t } = useTranslation()
  const form = useFormContext<Record<string, Value>>()
  const values = form.watch()
  const definition = descriptor.definition
  const renderField = (key: string, accessory?: string, compact = false) => {
    const field = definition.fields.find((f) => f.field === key)
    if (!field) return null

    if (
      field.visibleWhen &&
      !matchesOperationCondition(field.visibleWhen, values)
    )
      return null
    const schema = descriptor.argsSchema.properties?.[field.field]
    if (!schema) return null
    const file = definition.files?.[field.field]
    const disabled =
      blocked ||
      !!(
        field.enabledWhen &&
        !matchesOperationCondition(field.enabledWhen, values)
      )
    const label = field.label ?? schema.title ?? field.field
    const fieldId = `${id}-${field.field}`
    const error = form.formState.errors[field.field]?.message
    const required =
      descriptor.argsSchema.required?.includes(field.field) === true
    const describedBy =
      [
        (field.help && !file) || error ? `${fieldId}-help` : undefined,
        required ? `${fieldId}-required` : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined
    const options = schema.enum as string[] | undefined
    return (
      <div key={field.field} className="min-w-0 space-y-2">
        {!(compact || file?.kind === 'input-file') && (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={fieldId}>{label}</Label>
            {accessory && renderField(accessory, undefined, true)}
          </div>
        )}
        {required && (
          <span id={`${fieldId}-required`} className="sr-only">
            {t('pluginOperations.requiredField')}
          </span>
        )}
        {file ? (
          <DirectoryPicker
            name={field.field}
            variant="file"
            prefixLabel={file.kind === 'input-file' ? label : undefined}
            disabled={disabled}
            file={{ kind: file.kind === 'input-file' ? 'open' : 'save' }}
            displayValue={
              draft?.files[field.field]?.location ??
              draft?.suggestions?.[field.field] ??
              ''
            }
            placeholder={field.appearance?.placeholder}
            browseLabel={field.appearance?.browseLabel ?? label}
            fileHint={field.help}
            fileIcon={<OperationFieldIcon name={field.appearance?.icon} />}
            fileIconClassName={fieldTones[field.appearance?.tone ?? 'neutral']}
            allowDrop={field.appearance?.drop === true}
            dropOverride={(path) => drop(field.field, path)}
            pickOverride={() => pick(field.field)}
            onPickingChange={onPending}
            onPickError={onError}
            inputProps={{
              id: fieldId,
              'aria-invalid': !!error,
              'aria-describedby': describedBy,
            }}
          />
        ) : schema.type === 'boolean' ? (
          <Switch
            id={fieldId}
            checked={values[field.field] === true}
            onCheckedChange={(v) => change(field.field, v)}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-label={compact ? label : undefined}
          />
        ) : options && field.widget === 'segmented' ? (
          <ToggleGroup
            id={fieldId}
            value={[String(values[field.field] ?? '')]}
            onValueChange={(v) => {
              if (v[0]) change(field.field, v[0])
            }}
            disabled={disabled}
            aria-label={label}
            aria-describedby={describedBy}
          >
            {options.map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={field.optionLabels?.[value] ?? value}
              >
                {field.optionLabels?.[value] ?? value}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : options ? (
          <Select
            value={String(values[field.field] ?? '')}
            onValueChange={(v) => {
              if (v !== null) change(field.field, v)
            }}
            disabled={disabled}
          >
            <SelectTrigger
              id={fieldId}
              aria-invalid={!!error}
              aria-describedby={describedBy}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((value) => (
                <SelectItem key={value} value={value}>
                  {field.optionLabels?.[value] ?? value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : field.widget === 'textarea' ? (
          <Textarea
            id={fieldId}
            {...form.register(field.field)}
            placeholder={field.appearance?.placeholder}
            maxLength={schema.maxLength}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            aria-label={compact ? label : undefined}
          />
        ) : (
          <Input
            id={fieldId}
            {...form.register(field.field, {
              valueAsNumber:
                schema.type === 'number' || schema.type === 'integer',
            })}
            type={
              schema.type === 'number' || schema.type === 'integer'
                ? 'number'
                : 'text'
            }
            placeholder={field.appearance?.placeholder}
            step={schema.type === 'integer' ? 1 : 'any'}
            min={schema.minimum}
            max={schema.maximum}
            maxLength={schema.maxLength}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            aria-label={compact ? label : undefined}
          />
        )}
        {((field.help && !file) || error) && (
          <p
            id={`${fieldId}-help`}
            className={
              error
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {error || field.help}
          </p>
        )}
      </div>
    )
  }
  const renderNode = (node: OperationLayout, key: string) => {
    const span = node.span === 2 ? 'sm:col-span-2' : ''
    if (node.type === 'field')
      return (
        <div key={key} className={span} data-operation-field={node.field}>
          {renderField(node.field, node.accessory)}
        </div>
      )
    if (node.type === 'text') {
      if (
        node.platform &&
        node.platform !== (__MOTRIX_TARGET__ === 'electron' ? 'desktop' : 'web')
      )
        return null
      return (
        <p
          key={key}
          className={`${span} text-xs leading-relaxed ${node.tone === 'info' ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {node.text}
        </p>
      )
    }
    const content = node.children.map((child, index) =>
      renderNode(child, `${key}-${index}`)
    )
    const className =
      node.type === 'grid'
        ? `grid grid-cols-1 gap-3 ${node.columns === 2 ? 'sm:grid-cols-2' : ''}`
        : 'space-y-3'
    if (node.type === 'group' && node.collapsible)
      return (
        <Collapsible
          key={key}
          defaultOpen
          className={`${span} rounded-xl border bg-card p-4`}
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
            {node.title}
            <ChevronDownIcon aria-hidden className="size-4" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className={className}>{content}</div>
          </CollapsibleContent>
        </Collapsible>
      )
    return (
      <div
        key={key}
        className={`${span} ${node.type === 'group' ? 'rounded-xl border bg-card p-4' : ''}`}
        data-operation-layout={node.type}
      >
        {node.title && <p className="mb-3 text-sm font-medium">{node.title}</p>}
        <div className={className}>{content}</div>
      </div>
    )
  }
  return definition.ui ? (
    renderNode(definition.ui.layout, 'root')
  ) : (
    <div className="space-y-3">
      {definition.fields.map((field) => renderField(field.field))}
    </div>
  )
}
