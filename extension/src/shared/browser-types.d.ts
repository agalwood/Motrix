import '@wxt-dev/browser'

// Firefox contextual identities are not part of Chrome's generated Tab type.
// Keep vendor additions scoped to the imported Browser namespace.
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab
declare module '@wxt-dev/browser' {
  namespace Browser {
    namespace tabs {
      interface Tab {
        cookieStoreId?: string | undefined
      }
    }
  }
}
