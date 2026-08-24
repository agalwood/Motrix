export const CSS_VARS = {
  APP_FONT_FAMILY: '--app-font-family',
} as const

type CssVar = (typeof CSS_VARS)[keyof typeof CSS_VARS]

export function setGlobalCssVar(name: CssVar, value: string): void {
  document.documentElement.style.setProperty(name, value)
}

export function removeGlobalCssVar(name: CssVar): void {
  document.documentElement.style.removeProperty(name)
}
