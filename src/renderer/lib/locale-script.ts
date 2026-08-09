const CJK_SCRIPTS = new Set(['Hans', 'Hant', 'Jpan', 'Kore'])

export function isCjkLocale(locale: string): boolean {
  try {
    const script = new Intl.Locale(locale).maximize().script
    return script !== undefined && CJK_SCRIPTS.has(script)
  } catch {
    return false
  }
}
