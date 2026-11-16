import { Queries } from '@shared/protocol/queries'

export const transport = {
  platform: 'web',
  async invoke(channel: string) {
    if (channel === Queries.GetSettings) {
      const explicit = new URL(location.href).searchParams.has('explicit')
      return {
        app: {
          theme: explicit ? 'light' : 'system',
          language: explicit ? 'en-US' : 'system',
        },
      }
    }
    return {}
  },
  on() {},
  off() {},
  onConnectionChange() {
    return () => {}
  },
}
