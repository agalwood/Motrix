import { ChevronDownIcon } from '@renderer/components/icons'

export function MotrixLogo() {
  return (
    <>
      <span
        aria-hidden="true"
        data-slot="motrix-menu-logo"
        className="h-2.5 w-11 shrink-0 bg-foreground"
        style={{
          maskImage: 'url("./mo-logo.svg")',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
          maskSize: 'contain',
          WebkitMaskImage: 'url("./mo-logo.svg")',
          WebkitMaskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
        }}
      />
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
    </>
  )
}
