import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '@/components/copy-button'

export function CopyConnectionDiagnostics({
  text,
}: {
  text: string
}): React.ReactElement {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const label = t('options.help.copyDiagnostics')

  const copy = async (): Promise<void> => {
    setFailed(false)
    try {
      // Call in the click handler before any await to retain user activation.
      await navigator.clipboard.writeText(text)
    } catch (error) {
      setFailed(true)
      throw error
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <CopyButton
        size="icon-sm"
        variant="ghost"
        className="size-7 p-0"
        aria-label={label}
        title={label}
        copiedLabel={t('options.help.copied')}
        onClick={copy}
      />
      {failed && (
        <span role="status" className="max-w-44 text-xs text-destructive">
          {t('errors.connection.diagnosticsCopyFailed')}
        </span>
      )}
    </div>
  )
}
