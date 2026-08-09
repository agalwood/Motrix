import type { ComponentType, ReactElement } from 'react'
import { AboutDialog } from './cards/about-dialog'
import { AdvancedDialog } from './cards/advanced-dialog'
import { AppearanceDialog } from './cards/appearance-dialog'
import { BitTorrentDialog } from './cards/bit-torrent-dialog'
import type { SettingsCardDialogProps } from './cards/card-types'
import { DownloadsDialog } from './cards/downloads-dialog'
import { GeneralDialog } from './cards/general-dialog'
import { IntegrationDialog } from './cards/integration/integration-dialog'
import { NetworkDialog } from './cards/network-dialog'

const iconGeneral1x = new URL('./icons/icon-general@1x.png', import.meta.url)
  .href
const iconGeneral2x = new URL('./icons/icon-general@2x.png', import.meta.url)
  .href
const iconAppearance1x = new URL(
  './icons/icon-appearance@1x.png',
  import.meta.url
).href
const iconAppearance2x = new URL(
  './icons/icon-appearance@2x.png',
  import.meta.url
).href
const iconDownloads1x = new URL('./icons/icon-download@1x.png', import.meta.url)
  .href
const iconDownloads2x = new URL('./icons/icon-download@2x.png', import.meta.url)
  .href
const iconBittorrent1x = new URL(
  './icons/icon-bittorrent@1x.png',
  import.meta.url
).href
const iconBittorrent2x = new URL(
  './icons/icon-bittorrent@2x.png',
  import.meta.url
).href
const iconIntegration1x = new URL(
  './icons/icon-integration@1x.png',
  import.meta.url
).href
const iconIntegration2x = new URL(
  './icons/icon-integration@2x.png',
  import.meta.url
).href
const iconNetwork1x = new URL('./icons/icon-network@1x.png', import.meta.url)
  .href
const iconNetwork2x = new URL('./icons/icon-network@2x.png', import.meta.url)
  .href
const iconAdvanced1x = new URL('./icons/icon-advanced@1x.png', import.meta.url)
  .href
const iconAdvanced2x = new URL('./icons/icon-advanced@2x.png', import.meta.url)
  .href
const iconAbout1x = new URL('./icons/icon-about@1x.png', import.meta.url).href
const iconAbout2x = new URL('./icons/icon-about@2x.png', import.meta.url).href

function createSettingsIcon(
  id: string,
  src1x: string,
  src2x: string
): ReactElement {
  return (
    <img
      src={src1x}
      srcSet={`${src1x} 1x, ${src2x} 2x`}
      alt={id}
      draggable={false}
    />
  )
}

export interface SettingsCard {
  id: string
  icon: ReactElement
  labelKey: string
  descKey: string
  Dialog: ComponentType<SettingsCardDialogProps>
}

export const SETTINGS_CARDS: readonly SettingsCard[] = [
  {
    id: 'general',
    icon: createSettingsIcon('general', iconGeneral1x, iconGeneral2x),
    labelKey: 'settings.cards.general.title',
    descKey: 'settings.cards.general.desc',
    Dialog: GeneralDialog,
  },
  {
    id: 'appearance',
    icon: createSettingsIcon('appearance', iconAppearance1x, iconAppearance2x),
    labelKey: 'settings.cards.appearance.title',
    descKey: 'settings.cards.appearance.desc',
    Dialog: AppearanceDialog,
  },
  {
    id: 'downloads',
    icon: createSettingsIcon('downloads', iconDownloads1x, iconDownloads2x),
    labelKey: 'settings.cards.downloads.title',
    descKey: 'settings.cards.downloads.desc',
    Dialog: DownloadsDialog,
  },
  {
    id: 'bittorrent',
    icon: createSettingsIcon('bittorrent', iconBittorrent1x, iconBittorrent2x),
    labelKey: 'settings.cards.bittorrent.title',
    descKey: 'settings.cards.bittorrent.desc',
    Dialog: BitTorrentDialog,
  },
  {
    id: 'integration',
    icon: createSettingsIcon(
      'integration',
      iconIntegration1x,
      iconIntegration2x
    ),
    labelKey: 'settings.cards.integration.title',
    descKey: 'settings.cards.integration.desc',
    Dialog: IntegrationDialog,
  },
  {
    id: 'network',
    icon: createSettingsIcon('network', iconNetwork1x, iconNetwork2x),
    labelKey: 'settings.cards.network.title',
    descKey: 'settings.cards.network.desc',
    Dialog: NetworkDialog,
  },
  {
    id: 'advanced',
    icon: createSettingsIcon('advanced', iconAdvanced1x, iconAdvanced2x),
    labelKey: 'settings.cards.advanced.title',
    descKey: 'settings.cards.advanced.desc',
    Dialog: AdvancedDialog,
  },
  {
    id: 'about',
    icon: createSettingsIcon('about', iconAbout1x, iconAbout2x),
    labelKey: 'settings.cards.about.title',
    descKey: 'settings.cards.about.desc',
    Dialog: AboutDialog,
  },
] as const

export function findCard(id: string | undefined): SettingsCard | undefined {
  if (!id) return undefined
  return SETTINGS_CARDS.find((c) => c.id === id)
}
