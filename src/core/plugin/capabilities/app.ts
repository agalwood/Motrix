import { resolveSupportedLocale } from '@shared/constants/locales'
import type { AppCapabilitySnapshot } from './interface'

export interface AppCapabilityHostOptions {
  appVersion: string
  runtime: 'electron' | 'server'
}

export class AppCapabilityHost {
  constructor(private readonly opts: AppCapabilityHostOptions) {}
  snapshot(): AppCapabilitySnapshot {
    return {
      version: this.opts.appVersion,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      runtime: this.opts.runtime,
      locale: resolveSupportedLocale(process.env.LANG),
      arch: process.arch as 'x64' | 'arm64',
    }
  }
}
