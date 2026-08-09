import {
  SidebarMenuButton,
  SidebarMenuItem,
} from '@renderer/components/ui/sidebar'
import { Bell } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { useNotifications } from './use-notifications'

const UNREAD_DISPLAY_CAP = 99

/**
 * Sidebar footer nav entry (Task 17R rework, 2026-08-04 — supersedes Task
 * 17's Popover design per the user's mid-Phase-C decision: the notification
 * center is a dedicated page, not a popover). A `NavLink` to `/notifications`,
 * rendered as a sibling `SidebarMenuItem` inside `AppSidebar`'s
 * `<SidebarFooter><SidebarMenu>`, BEFORE the `SidebarSeparator` + Settings
 * entry. `useNotifications({ countOnly: true })` drives the badge here
 * independently of `NotificationsPage`'s own instance — the page only
 * mounts when routed, so the two never double-fetch while the page is
 * off-screen. This item is always mounted (sidebar footer) and only ever
 * reads `unreadCount`, so `countOnly` skips the `ListNotifications` query
 * entirely rather than paying for a 100-row fetch it never renders.
 */
export function NotificationsNavItem() {
  const { t } = useTranslation()
  const { unreadCount } = useNotifications({ countOnly: true })
  const badgeLabel =
    unreadCount > UNREAD_DISPLAY_CAP
      ? `${UNREAD_DISPLAY_CAP}+`
      : String(unreadCount)

  return (
    <SidebarMenuItem>
      <NavLink to="/notifications">
        {({ isActive }) => (
          <SidebarMenuButton
            render={<span />}
            isActive={isActive}
            tooltip={t('nav.notifications')}
            className="relative cursor-default"
          >
            <Bell />
            <span className="select-none">{t('nav.notifications')}</span>
            {unreadCount > 0 && (
              <>
                <span
                  data-testid="notification-badge"
                  role="status"
                  aria-label={t('notification.center.unreadBadgeAria', {
                    count: unreadCount,
                  })}
                  className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-white tabular-nums group-data-[collapsible=icon]:hidden"
                >
                  {badgeLabel}
                </span>
                <span
                  data-testid="notification-badge-dot"
                  aria-hidden="true"
                  className="absolute top-1 right-1 hidden size-1.5 rounded-full bg-destructive group-data-[collapsible=icon]:block"
                />
              </>
            )}
          </SidebarMenuButton>
        )}
      </NavLink>
    </SidebarMenuItem>
  )
}
