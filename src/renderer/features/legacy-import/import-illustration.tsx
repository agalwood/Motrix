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
      width={128}
      height={128}
      alt=""
      className="size-full object-contain brightness-90 contrast-[1.12] saturate-[1.2] drop-shadow-[0_1px_1px_rgb(15_23_42/0.12)] dark:filter-none"
      draggable={false}
    />
  )
}
