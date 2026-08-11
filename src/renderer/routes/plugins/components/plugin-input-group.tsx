import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useDragDepth } from '@renderer/hooks/use-drag-depth'
import { cn } from '@renderer/lib/utils'
import {
  type PluginInstallFileReference,
  useOptionalPlatformServices,
} from '@renderer/platform/services'
import { Paperclip, Search } from 'lucide-react'
import { type ChangeEvent, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getAudienceTone } from '../lib/audience'
import {
  type DetectedSource,
  detectInstallSource,
} from '../lib/detect-install-source'

const SAFE_TONE = getAudienceTone('safe')
const OPTIONAL_TONE = getAudienceTone('optional')

export type CheckArgs =
  | { sourceType: 'github'; spec: string }
  | { sourceType: 'url'; url: string }
  | PluginInstallFileReference

interface Props {
  onCheck: (args: CheckArgs) => void | Promise<void>
  checking: boolean
}

export function PluginInputGroup({ onCheck, checking }: Props) {
  const { t } = useTranslation()
  const platform = useOptionalPlatformServices()
  const fileCapability = platform?.pluginInstallFile
  const [input, setInput] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const detected: DetectedSource = detectInstallSource(input)
  const canCheck = !!detected && !checking && detected !== 'local'

  const acceptFile = useCallback(
    async (file: File) => {
      if (checking || !fileCapability) return
      setFileError(null)
      setInput(file.name)
      try {
        await onCheck(await fileCapability.prepare(file))
      } catch (cause) {
        setFileError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [onCheck, checking, fileCapability]
  )

  const onFilesDrop = useCallback(
    (files: FileList) => {
      if (!fileCapability || checking) return
      const file = files[0]
      if (file) void acceptFile(file)
    },
    [fileCapability, acceptFile, checking]
  )

  const { isDragging, dragHandlers } = useDragDepth<HTMLElement>(onFilesDrop)
  const showDragOverlay = isDragging && Boolean(fileCapability)

  function onLocalChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void acceptFile(file)
  }

  async function triggerCheck() {
    if (!detected) return
    if (detected === 'github') {
      await onCheck({ sourceType: 'github', spec: input.trim() })
    } else if (detected === 'url') {
      await onCheck({ sourceType: 'url', url: input.trim() })
    }
  }

  return (
    <section
      aria-label={t('plugins.install.lead')}
      {...dragHandlers}
      className={cn(
        'relative overflow-hidden rounded-xl transition-colors',
        showDragOverlay &&
          'border-1 border-dashed border-blue-500 bg-blue-50/50'
      )}
    >
      {showDragOverlay && (
        <div className="absolute inset-2 grid place-items-center rounded-lg bg-blue-50/90 font-semibold text-blue-700">
          {t('plugins.install.dropHint')}
        </div>
      )}

      <InputGroup className="min-h-[132px] items-stretch rounded-xl bg-background shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupTextarea
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('plugins.install.placeholder')}
          className="min-h-[60px] px-4 pt-4 pb-2 text-sm leading-6 focus-visible:border-input focus-visible:ring-0"
        />
        <InputGroupAddon
          align="block-end"
          className="flex-wrap justify-between gap-3 px-4 pb-4"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    /* A focusable wrapper lets the tooltip remain available when the button is disabled. */
                    <span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="rounded-full"
                        disabled={!fileCapability || checking}
                        onClick={() => fileInputRef.current?.click()}
                        aria-label={t(
                          fileCapability
                            ? 'plugins.install.pickLocal'
                            : 'plugins.install.localUnavailable'
                        )}
                      >
                        <Paperclip className="size-4" />
                      </Button>
                    </span>
                  }
                />
                {!fileCapability && (
                  <TooltipContent>
                    {t('plugins.install.localUnavailable')}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>

            <input
              ref={fileInputRef}
              type="file"
              accept=".moext,application/zip"
              hidden
              onChange={onLocalChange}
            />

            {detected && (
              <Badge variant="outline" className="h-6 font-medium">
                {t(`plugins.install.detected.${detected}`)}
              </Badge>
            )}
          </div>

          {detected !== 'local' && (
            <Button
              size="icon-xs"
              className="rounded-full"
              disabled={!canCheck}
              onClick={triggerCheck}
              aria-label={t('plugins.install.checkAriaLabel')}
            >
              <Search />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>

      {detected && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge
            variant="outline"
            className={cn(
              'h-6 border-transparent px-2 font-medium',
              SAFE_TONE.bg,
              SAFE_TONE.text
            )}
          >
            {t('plugins.install.detectedRow.ok', {
              type: t(`plugins.install.detected.${detected}`),
            })}
          </Badge>
          {fileCapability && (
            <Badge
              variant="outline"
              className={cn(
                'h-6 border-transparent px-2 font-medium',
                OPTIONAL_TONE.bg,
                OPTIONAL_TONE.text
              )}
            >
              {t('plugins.install.detectedRow.localSupported')}
            </Badge>
          )}
        </div>
      )}
      {fileError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t('plugins.install.localPrepareFailed', { detail: fileError })}
        </p>
      )}
    </section>
  )
}
