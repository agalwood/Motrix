import type { MediaMetaStore } from '@core/task/media-meta-store'
import { vi } from 'vitest'

export function makeMediaMetaStoreStub() {
  return {
    persist: vi.fn<MediaMetaStore['persist']>(
      async (id) => `/metadata/media/${id}/files.json`
    ),
    read: vi.fn<MediaMetaStore['read']>(async () => null),
    update: vi.fn<MediaMetaStore['update']>(),
    release: vi.fn<MediaMetaStore['release']>(async () => {}),
    remove: vi.fn<MediaMetaStore['remove']>(async () => {}),
  } satisfies MediaMetaStore
}
