import type { MotrixIcon } from '@renderer/components/icons'
import {
  DashboardIcon,
  DownloadLibraryIcon,
  MigrationIcon,
  PluginIcon,
  SettingsIcon,
  TrackerIcon,
} from '@renderer/components/icons'
import { NotificationsNavItem } from '@renderer/components/notification-center/notifications-nav-item'
import { useDirection } from '@renderer/components/ui/direction'
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
import { useLegacyImportNavigation } from '@renderer/features/legacy-import/use-legacy-import-navigation'
import { LEGACY_MIGRATION_ROUTE } from '@shared/lib/legacy-import-navigation'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { SidebarSelectionIndicator } from './sidebar-selection-indicator'

interface NavItem {
  to: string
  icon: MotrixIcon
  labelKey: string
  end?: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', icon: DashboardIcon, labelKey: 'nav.dashboard', end: true },
  { to: '/downloads', icon: DownloadLibraryIcon, labelKey: 'nav.downloads' },
  { to: '/trackers', icon: TrackerIcon, labelKey: 'nav.trackers' },
  { to: '/plugins', icon: PluginIcon, labelKey: 'nav.plugins' },
] as const

const FOOTER_NAV_ITEMS: readonly NavItem[] = [
  { to: '/settings', icon: SettingsIcon, labelKey: 'nav.settings' },
] as const

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const navContainerRef = useRef<HTMLDivElement>(null)
  const direction = useDirection()
  const { visible } = useLegacyImportNavigation()
  const items = visible
    ? [
        ...NAV_ITEMS,
        {
          to: LEGACY_MIGRATION_ROUTE,
          icon: MigrationIcon,
          labelKey: 'legacyImport.navigation',
        },
      ]
    : NAV_ITEMS

  return (
    <Sidebar
      variant="inset"
      side={direction === 'rtl' ? 'right' : 'left'}
      {...props}
    >
      <SidebarHeader
        style={{
          height: 45,
        }}
      ></SidebarHeader>
      <div
        ref={navContainerRef}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <SidebarSelectionIndicator containerRef={navContainerRef} />
        <SidebarContent className="relative z-10">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
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
        <SidebarFooter className="relative z-10 px-0.5">
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
      </div>
    </Sidebar>
  )
}
