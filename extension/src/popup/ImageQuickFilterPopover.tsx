import { SlidersHorizontal } from 'lucide-react'
import { type RefObject, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  countActiveImageQuickFilters,
  type ImageQuickFilters,
} from '@/popup/imageQuickFilters'

type ComparisonOperator = 'gte' | 'eq' | 'lte'
type NumericFilter = 'width' | 'height' | 'size'
type SizeUnit = 'kb' | 'mb'

const OPERATORS: readonly ComparisonOperator[] = ['gte', 'eq', 'lte']
const OPERATOR_SYMBOLS: Record<ComparisonOperator, string> = {
  gte: '≥',
  eq: '=',
  lte: '≤',
}
const SIZE_MULTIPLIERS: Record<SizeUnit, number> = {
  kb: 1024,
  mb: 1024 * 1024,
}
const SIZE_UNIT_LABELS: Record<SizeUnit, string> = { kb: 'KB', mb: 'MB' }

interface ImageQuickFilterPopoverProps {
  filters: ImageQuickFilters
  availableFormats: readonly string[]
  matchedCount: number
  totalCount: number
  positionAnchor?: RefObject<HTMLElement | null>
  onChange: (filters: ImageQuickFilters) => void
  onReset: () => void
}

function normalizedFormat(value: string): string {
  const normalized = value.trim().toUpperCase()
  return normalized === 'JPEG' ? 'JPG' : normalized
}

function formatOptions(
  availableFormats: readonly string[],
  selectedFormats: readonly string[]
): string[] {
  const seen = new Set<string>()
  const formats: string[] = []
  for (const candidate of [...availableFormats, ...selectedFormats]) {
    const normalized = normalizedFormat(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    formats.push(normalized)
  }
  return formats
}

function withoutNumericFilter(
  filters: ImageQuickFilters,
  key: NumericFilter
): ImageQuickFilters {
  const next = { ...filters }
  delete next[key]
  return next
}

function finiteNonNegative(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN
}

function compactDecimal(value: number): string {
  return String(Number(value.toFixed(6)))
}

function NumericFilterRow({
  filterKey,
  filters,
  operator,
  unit,
  wideUnit = false,
  unitMultiplier = 1,
  onOperatorChange,
  onChange,
}: {
  filterKey: NumericFilter
  filters: ImageQuickFilters
  operator: ComparisonOperator
  unit: React.ReactNode
  wideUnit?: boolean
  unitMultiplier?: number
  onOperatorChange: (operator: ComparisonOperator) => void
  onChange: (filters: ImageQuickFilters) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const condition = filters[filterKey]
  const value = condition
    ? compactDecimal(condition.value / unitMultiplier)
    : ''
  const label = t(`popup.sniffer.imageFilters.fields.${filterKey}`)

  const updateValue = (rawValue: string): void => {
    const parsed = finiteNonNegative(rawValue)
    if (parsed === null) {
      onChange(withoutNumericFilter(filters, filterKey))
      return
    }
    if (!Number.isFinite(parsed)) return
    const convertedValue = parsed * unitMultiplier
    if (!Number.isSafeInteger(convertedValue)) return
    onChange({
      ...filters,
      [filterKey]: {
        operator,
        value: convertedValue,
      },
    })
  }

  return (
    <div
      className={cn(
        'grid items-center gap-1.5',
        wideUnit
          ? 'grid-cols-[40px_52px_minmax(0,1fr)_58px]'
          : 'grid-cols-[40px_52px_minmax(0,1fr)_24px]'
      )}
    >
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select
        value={operator}
        items={OPERATOR_SYMBOLS}
        onValueChange={(value) => onOperatorChange(value as ComparisonOperator)}
      >
        <SelectTrigger
          size="sm"
          className="w-[52px] px-1.5 py-0 text-[11px] shadow-none data-[size=sm]:h-6"
          aria-label={t('popup.sniffer.imageFilters.operatorLabel', { label })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="min-w-[52px] shadow-sm"
        >
          {OPERATORS.map((candidate) => (
            <SelectItem
              key={candidate}
              value={candidate}
              className="text-[11px]"
            >
              {OPERATOR_SYMBOLS[candidate]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={value}
        placeholder="0"
        aria-label={t('popup.sniffer.imageFilters.valueLabel', { label })}
        className="h-6 px-2 text-[11px] shadow-none"
        onChange={(event) => updateValue(event.currentTarget.value)}
      />
      {typeof unit === 'string' ? (
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      ) : (
        unit
      )}
    </div>
  )
}

export function ImageQuickFilterPopover({
  filters,
  availableFormats,
  matchedCount,
  totalCount,
  positionAnchor,
  onChange,
  onReset,
}: ImageQuickFilterPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const activeCountDescriptionId = useId()
  const [open, setOpen] = useState(false)
  const [operators, setOperators] = useState<
    Record<NumericFilter, ComparisonOperator>
  >({ width: 'gte', height: 'gte', size: 'gte' })
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('kb')
  const activeCount = countActiveImageQuickFilters(filters)
  const formats = useMemo(
    () => formatOptions(availableFormats, filters.formats),
    [availableFormats, filters.formats]
  )

  const currentOperator = (key: NumericFilter): ComparisonOperator =>
    filters[key]?.operator ?? operators[key]

  const updateOperator = (
    key: NumericFilter,
    operator: ComparisonOperator
  ): void => {
    setOperators((current) => ({ ...current, [key]: operator }))
    const condition = filters[key]
    if (!condition) return
    onChange({ ...filters, [key]: { ...condition, operator } })
  }

  const toggleFormat = (format: string): void => {
    const selected = new Set(filters.formats.map(normalizedFormat))
    if (selected.has(format)) selected.delete(format)
    else selected.add(format)
    onChange({ ...filters, formats: [...selected] })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={t('popup.sniffer.imageFilters.trigger')}
        aria-describedby={
          activeCount > 0 ? activeCountDescriptionId : undefined
        }
        className={cn(
          buttonVariants({ variant: activeCount > 0 ? 'secondary' : 'ghost' }),
          'relative h-8 gap-1.5 rounded-lg px-2.5 text-xs shadow-none'
        )}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden="true" />
        {t('popup.sniffer.imageFilters.trigger')}
        {activeCount > 0 && (
          <span
            className="flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground"
            aria-hidden="true"
          >
            {activeCount}
          </span>
        )}
        {activeCount > 0 && (
          <span id={activeCountDescriptionId} className="sr-only">
            {t('popup.sniffer.imageFilters.activeCount', {
              count: activeCount,
            })}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        anchor={positionAnchor}
        side="top"
        sideOffset={8}
        align="start"
        className={cn(
          'max-w-(--available-width) space-y-2 p-2.5',
          positionAnchor ? 'w-(--anchor-width)' : 'w-[368px]'
        )}
      >
        <PopoverHeader className="flex-row items-center gap-1.5">
          <PopoverTitle className="text-[13px]/4">
            {t('popup.sniffer.imageFilters.title')}
          </PopoverTitle>
          <span
            className="ms-auto text-[11px] tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {t('popup.sniffer.imageFilters.result', {
              matched: matchedCount,
              total: totalCount,
            })}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activeCount === 0}
            onClick={onReset}
          >
            {t('popup.sniffer.imageFilters.reset')}
          </Button>
          <Button type="button" size="xs" onClick={() => setOpen(false)}>
            {t('popup.sniffer.imageFilters.done')}
          </Button>
        </PopoverHeader>

        <fieldset className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-1.5">
          <legend className="sr-only">
            {t('popup.sniffer.imageFilters.formats')}
          </legend>
          <span
            aria-hidden="true"
            className="text-[11px] text-muted-foreground"
          >
            {t('popup.sniffer.imageFilters.formats')}
          </span>
          <div className="flex min-h-6 flex-wrap gap-1">
            {formats.length > 0 ? (
              formats.map((format) => {
                const selected = filters.formats
                  .map(normalizedFormat)
                  .includes(format)
                return (
                  <button
                    key={format}
                    type="button"
                    aria-pressed={selected}
                    aria-label={t(
                      'popup.sniffer.imageFilters.formatOptionLabel',
                      { format: format.toUpperCase() }
                    )}
                    className={cn(
                      'h-6 rounded-md border px-2 text-[10px] font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
                      selected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    onClick={() => toggleFormat(format)}
                  >
                    {format.toUpperCase()}
                  </button>
                )
              })
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </fieldset>

        <section
          className="space-y-1.5"
          aria-label={t('popup.sniffer.imageFilters.dimensions')}
        >
          <NumericFilterRow
            filterKey="width"
            filters={filters}
            operator={currentOperator('width')}
            unit="px"
            onOperatorChange={(operator) => updateOperator('width', operator)}
            onChange={onChange}
          />
          <NumericFilterRow
            filterKey="height"
            filters={filters}
            operator={currentOperator('height')}
            unit="px"
            onOperatorChange={(operator) => updateOperator('height', operator)}
            onChange={onChange}
          />
          <NumericFilterRow
            filterKey="size"
            filters={filters}
            operator={currentOperator('size')}
            wideUnit
            unitMultiplier={SIZE_MULTIPLIERS[sizeUnit]}
            onOperatorChange={(operator) => updateOperator('size', operator)}
            onChange={onChange}
            unit={
              <Select
                value={sizeUnit}
                items={SIZE_UNIT_LABELS}
                onValueChange={(value) => setSizeUnit(value as SizeUnit)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-[58px] px-1.5 py-0 text-[11px] shadow-none data-[size=sm]:h-6"
                  aria-label={t('popup.sniffer.imageFilters.sizeUnitLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  alignItemWithTrigger={false}
                  className="min-w-[58px] shadow-sm"
                >
                  <SelectItem value="kb" className="text-[11px]">
                    KB
                  </SelectItem>
                  <SelectItem value="mb" className="text-[11px]">
                    MB
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </section>
      </PopoverContent>
    </Popover>
  )
}

export type { ImageQuickFilterPopoverProps }
