import { describe, expect, it } from 'vitest'
import {
  isSeverityEnabled,
  NOTIFICATIONS_DEFAULT,
  type NotificationsConfig,
} from '@/shared/notifications'

describe('notifications severity model', () => {
  it('default: master on, confirm off, error/reminder on', () => {
    expect(NOTIFICATIONS_DEFAULT).toEqual({
      master: true,
      confirm: false,
      error: true,
      reminder: true,
    })
  })

  it('master off suppresses every severity', () => {
    const cfg: NotificationsConfig = {
      master: false,
      confirm: true,
      error: true,
      reminder: true,
    }
    expect(isSeverityEnabled(cfg, 'confirm')).toBe(false)
    expect(isSeverityEnabled(cfg, 'error')).toBe(false)
    expect(isSeverityEnabled(cfg, 'reminder')).toBe(false)
  })

  it('master on gates per-severity bucket', () => {
    const cfg: NotificationsConfig = {
      master: true,
      confirm: false,
      error: true,
      reminder: true,
    }
    expect(isSeverityEnabled(cfg, 'confirm')).toBe(false)
    expect(isSeverityEnabled(cfg, 'error')).toBe(true)
    expect(isSeverityEnabled(cfg, 'reminder')).toBe(true)
  })
})
