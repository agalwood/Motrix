// Server-runtime stub for the notify capability.
//
// The Node/Docker server has no native desktop notification surface.
// Re-export UnavailableNotifyHost so the Task 18 factory can reference a
// consistent type without pulling in any Electron code.

export { UnavailableNotifyHost } from '@core/plugin/capabilities/notify'
