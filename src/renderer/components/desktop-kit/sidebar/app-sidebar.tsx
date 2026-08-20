import { NotificationsNavItem } from '@renderer/components/notification-center/notifications-nav-item'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@renderer/components/ui/sidebar'
import type { LucideIcon } from 'lucide-react'
import {
  Download,
  LayoutDashboard,
  RadioTower,
  Settings,
  ToyBrick,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'

interface NavItem {
  to: string
  icon: LucideIcon
  labelKey: string
  end?: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard', end: true },
  { to: '/downloads', icon: Download, labelKey: 'nav.downloads' },
  { to: '/trackers', icon: RadioTower, labelKey: 'nav.trackers' },
  { to: '/plugins', icon: ToyBrick, labelKey: 'nav.plugins' },
] as const

const FOOTER_NAV_ITEMS: readonly NavItem[] = [
  { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
] as const

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader
        style={{
          height: 45,
        }}
      ></SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.to}>
                    <NavLink to={item.to} end={item.end}>
                      {({ isActive }) => (
                        <SidebarMenuButton
                          render={<span />}
                          isActive={isActive}
                          tooltip={t(item.labelKey)}
                          className="cursor-default"
                        >
                          <Icon />
                          <span className="select-none">
                            {t(item.labelKey)}
                          </span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-0.5">
        <SidebarMenu>
          <NotificationsNavItem />
          <SidebarMenuItem aria-hidden="true">
            <SidebarSeparator className="mx-0" />
          </SidebarMenuItem>
          {FOOTER_NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <SidebarMenuItem key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {({ isActive }) => (
                    <SidebarMenuButton
                      render={<span />}
                      isActive={isActive}
                      tooltip={t(item.labelKey)}
                      className="cursor-default"
                    >
                      <Icon />
                      <span className="select-none">{t(item.labelKey)}</span>
                    </SidebarMenuButton>
                  )}
                </NavLink>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
