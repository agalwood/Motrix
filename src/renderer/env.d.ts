/// <reference types="vite/client" />

declare const __MOTRIX_TARGET__: 'electron' | 'web'
declare const __MOTRIX_PREVIEW_MAC_MENU__: boolean

declare const __MOTRIX_APP_METADATA__: {
  readonly name: string
  readonly version: string
  readonly author: {
    readonly name: string
    readonly email: string
  }
  readonly license: string
}
