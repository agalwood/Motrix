// Built-in User-Agent presets exposed via the Downloads settings dialog.
// Versions are pinned and may need bumping over time as the defaults age.
// Pure data — safe to import from any layer.
export interface UserAgentPreset {
  label: string
  value: string
}

export const BUILTIN_USER_AGENTS: readonly UserAgentPreset[] = [
  { label: 'Motrix', value: 'Motrix/2.0' },
  {
    label: 'Chrome',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  },
  {
    label: 'Firefox',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0',
  },
  {
    label: 'Safari',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15',
  },
  { label: 'Transmission', value: 'Transmission/4.1.3' },
] as const
