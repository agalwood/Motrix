import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

interface FontComboboxProps {
  id?: string
  value: string
  onChange: (val: string) => void
  systemFonts: string[]
  isLoading?: boolean
  placeholder?: string
}

export function FontCombobox({
  id,
  value,
  onChange,
  systemFonts,
  isLoading = false,
  placeholder,
}: FontComboboxProps) {
  const [open, setOpen] = useState(false)

  const filteredFonts = useMemo(() => {
    const query = (value || '').trim().toLowerCase()
    if (!query) return systemFonts.slice(0, 100)
    return systemFonts
      .filter((font) => font.toLowerCase().includes(query))
      .slice(0, 100)
  }, [systemFonts, value])

  return (
    <Combobox
      open={open}
      onOpenChange={setOpen}
      value={value ?? ''}
      onValueChange={(val) => {
        if (val) {
          // Extract primary font, removing commas and extra spaces
          const cleanFont = val.split(',')[0].replace(/\s+/g, ' ').trim()
          onChange(cleanFont)
        } else {
          onChange('')
        }
        setOpen(false)
      }}
    >
      <div className="relative w-56">
        <ComboboxInput
          id={id}
          disabled={isLoading}
          value={value ?? ''}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          placeholder={placeholder}
          className="h-8 text-xs"
          showTrigger={!isLoading}
          showClear={Boolean(value) && !isLoading}
        />
        {isLoading && (
          <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground opacity-60" />
          </div>
        )}
      </div>

      <ComboboxContent align="start" className="w-56">
        <ComboboxList className="max-h-48 overflow-y-auto scrollbar-none hover:scrollbar-thin [&::-webkit-scrollbar]:hidden hover:[&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30">
          {isLoading ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              Loading system fonts...
            </div>
          ) : filteredFonts.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">
              No system fonts found
            </div>
          ) : (
            filteredFonts.map((font) => (
              <ComboboxItem
                key={font}
                value={font}
                style={{
                  fontFamily: `"${font.replace(/"/g, '\\"')}", monospace`,
                }}
                className="text-xs truncate"
              >
                {font}
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
