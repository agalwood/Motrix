import {
  ADD_TASK_COLLAPSED_HEIGHT,
  TASK_FORM_WIDTH,
} from '@shared/constants/add-task'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import type { WindowId } from '@shared/types/window'
import { WindowRoutes } from '@shared/types/window'

export type { WindowId }

export interface WindowConfig {
  id: WindowId
  title: string
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  resizable: boolean
  route: string
  closeBehavior: 'hide' | 'destroy'
  persistBounds: boolean
  maximizable: boolean
  vibrancy: boolean
  liquidGlass: boolean
  transparent?: boolean
}

export const WINDOW_CONFIGS: Record<WindowId, WindowConfig> = {
  main: {
    id: 'main',
    title: 'Motrix',
    width: 914,
    height: 672,
    minWidth: DEFAULT_APP_SETTINGS.mainWindowMinWidth,
    minHeight: DEFAULT_APP_SETTINGS.mainWindowMinHeight,
    resizable: true,
    route: WindowRoutes.main,
    closeBehavior: 'hide',
    persistBounds: true,
    maximizable: true,
    vibrancy: true,
    liquidGlass: true,
    transparent: true,
  },
  'add-task': {
    id: 'add-task',
    title: 'New Task',
    width: TASK_FORM_WIDTH,
    height: ADD_TASK_COLLAPSED_HEIGHT,
    resizable: false,
    route: WindowRoutes['add-task'],
    closeBehavior: 'destroy',
    persistBounds: false,
    maximizable: false,
    vibrancy: false,
    liquidGlass: false,
    transparent: false,
  },
  'create-torrent': {
    id: 'create-torrent',
    title: 'Motrix',
    width: TASK_FORM_WIDTH,
    height: ADD_TASK_COLLAPSED_HEIGHT,
    minWidth: 470,
    minHeight: 290,
    resizable: true,
    route: WindowRoutes['create-torrent'],
    closeBehavior: 'destroy',
    persistBounds: false,
    maximizable: false,
    vibrancy: false,
    liquidGlass: false,
  },
  onboarding: {
    id: 'onboarding',
    title: 'Motrix',
    width: 400,
    height: 670,
    resizable: false,
    route: WindowRoutes.onboarding,
    closeBehavior: 'destroy',
    persistBounds: false,
    maximizable: false,
    vibrancy: false,
    liquidGlass: true,
    transparent: false,
  },
}
