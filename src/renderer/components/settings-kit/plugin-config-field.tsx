import { Input } from '@renderer/components/ui/input'
import { NumberInput } from '@renderer/components/ui/number-input'
import { PasswordInput } from '@renderer/components/ui/password-input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import type { JsonSchemaNode } from '@shared/types/plugin'
import { useController, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

export function PluginConfigField({
  name,
  node,
}: {
  name: string
  node: JsonSchemaNode
}) {
  const { t } = useTranslation()
  const { control } = useFormContext()
  const { field } = useController({ name, control })

  if (node.type === 'boolean') {
    return <Switch checked={!!field.value} onCheckedChange={field.onChange} />
  }

  if (Array.isArray(node.enum)) {
    const options = node.enum.map((value) => {
      const label = String(value)
      return { label, value: label }
    })

    return (
      <Select
        items={options}
        value={(field.value as string | undefined) ?? ''}
        onValueChange={(value) => {
          if (value !== null) field.onChange(value)
        }}
      >
        <SelectTrigger className="w-full max-w-3xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    )
  }

  if (node.secret) {
    return (
      <PasswordInput
        value={(field.value as string | undefined) ?? ''}
        placeholder="********"
        onChange={field.onChange}
        onBlur={field.onBlur}
        showPasswordLabel={t('common.showPassword')}
        hidePasswordLabel={t('common.hidePassword')}
        className="w-full max-w-3xs h-8"
      />
    )
  }

  if (node.type === 'integer' || node.type === 'number') {
    return (
      <NumberInput
        value={typeof field.value === 'number' ? field.value : undefined}
        onChange={field.onChange}
        min={node.minimum}
        max={node.maximum}
        className="w-full max-w-3xs text-sm"
      />
    )
  }

  return (
    <Input
      value={(field.value as string | undefined) ?? ''}
      onChange={(e) => field.onChange(e.target.value)}
      className="w-full max-w-3xs h-8"
    />
  )
}
