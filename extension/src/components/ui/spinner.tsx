import { Loader2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  const { t } = useTranslation()
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={t('popup.loading')}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
