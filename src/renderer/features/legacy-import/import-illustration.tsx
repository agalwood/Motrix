const illustration1x = new URL('./icons/icon-import@1x.webp', import.meta.url)
  .href
const illustration2x = new URL('./icons/icon-import@2x.webp', import.meta.url)
  .href

/** The adjacent stage heading conveys the meaning of this decorative artwork. */
export function ImportIllustration() {
  return (
    <img
      data-slot="migration-import-illustration"
      src={illustration1x}
      srcSet={`${illustration1x} 1x, ${illustration2x} 2x`}
      width={96}
      height={96}
      alt=""
      className="size-full object-contain"
      draggable={false}
    />
  )
}
