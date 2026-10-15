// MUST be first: the shared bootstrap makes `browser.*` available in Chromium.

import { ContentRuntime } from '@/content/ContentRuntime'

const rt = new ContentRuntime(location.href)
if (rt.adapterId !== null) {
  void rt.bootstrap()
  rt.attach()
  console.log(`[motrix-ext][content] adapter ${rt.adapterId} attached`)
}
