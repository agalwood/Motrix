import type { AppCapabilitySnapshot } from './interface'

export interface AppCapabilityHostOptions {
  appVersion: string
  platform: AppCapabilitySnapshot['platform']
  runtime: 'electron' | 'server'
  locale: string
  arch: AppCapabilitySnapshot['arch']
}

export class AppCapabilityHost {
  constructor(private readonly opts: AppCapabilityHostOptions) {}
  snapshot(): AppCapabilitySnapshot {
    return {
      version: this.opts.appVersion,
      platform: this.opts.platform,
      runtime: this.opts.runtime,
      locale: this.opts.locale,
      arch: this.opts.arch,
    }
  }
}
