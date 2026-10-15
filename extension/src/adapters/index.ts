import { adapterRegistry as variantAdapterRegistry } from 'virtual:motrix-adapter-registry'
import type { SiteAdapter } from '@/adapters/SiteAdapter'

// The build plugin supplies the full registry for regular/Firefox builds and
// an empty registry for the Chrome Web Store artifact.
export const adapterRegistry: SiteAdapter[] = variantAdapterRegistry
