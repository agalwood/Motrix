export const EMPTY_STRING = ''

export const APP_THEME = {
  AUTO: 'auto',
  LIGHT: 'light',
  DARK: 'dark'
}

export const APP_RUN_MODE = {
  STANDARD: 1,
  MENU_BAR: 2
}

export const ADD_TASK_TYPE = {
  URI: 'uri',
  TORRENT: 'torrent'
}

export const TASK_STATUS = {
  ACTIVE: 'active',
  WAITING: 'waiting',
  PAUSED: 'paused',
  ERROR: 'error',
  COMPLETE: 'complete',
  REMOVED: 'removed',
  SEEDING: 'seeding'
}

export const ENGINE_RPC_HOST = '127.0.0.1'
export const ENGINE_RPC_PORT = 16800

/**
 * @see https://github.com/ngosang/trackerslist
 */
export const NGOSANG_TRACKERS_BEST_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt'
export const NGOSANG_TRACKERS_BEST_IP_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt'
export const NGOSANG_TRACKERS_ALL_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt'
export const NGOSANG_TRACKERS_ALL_IP_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt'

/**
 * @see https://github.com/XIU2/TrackersListCollection
 */
export const XIU2_TRACKERS_BEST_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt'
export const XIU2_TRACKERS_ALL_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt'
export const XIU2_TRACKERS_OTHER_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/other.txt'

// For bt-exclude-tracker
export const XIU2_TRACKERS_BLACK_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/blacklist.txt'

export const trackerSourceOptions = [
  {
    label: 'ngosang/trackerslist',
    options: [
      {
        value: NGOSANG_TRACKERS_BEST_URL,
        label: 'trackers_best.txt'
      },
      {
        value: NGOSANG_TRACKERS_BEST_IP_URL,
        label: 'trackers_best_ip.txt'
      },
      {
        value: NGOSANG_TRACKERS_ALL_URL,
        label: 'trackers_all.txt'
      },
      {
        value: NGOSANG_TRACKERS_ALL_IP_URL,
        label: 'trackers_all_ip.txt'
      }
    ]
  },
  {
    label: 'XIU2/TrackersListCollection',
    options: [
      {
        value: XIU2_TRACKERS_BEST_URL,
        label: 'best.txt'
      },
      {
        value: XIU2_TRACKERS_ALL_URL,
        label: 'all.txt'
      },
      {
        value: XIU2_TRACKERS_OTHER_URL,
        label: 'other.txt'
      }
    ]
  }
]

export const ONE_SECOND = 1000
export const ONE_MINUTE = ONE_SECOND * 60
export const ONE_HOUR = ONE_MINUTE * 60
export const ONE_DAY = ONE_HOUR * 24

// 12 Hours
export const AUTO_SYNC_TRACKER_INTERVAL = ONE_HOUR * 12

// One Week
export const AUTO_CHECK_UPDATE_INTERVAL = ONE_DAY * 7

export const NONE_SELECTED_FILES = 'none'
export const SELECTED_ALL_FILES = 'all'

export const ENGINE_MAX_CONNECTION_PER_SERVER = 64

export const IP_VERSION = {
  V4: 4,
  V6: 6
}

export const LOGIN_SETTING_OPTIONS = {
  // For Windows
  args: [
    '--opened-at-login=1'
  ]
}

export const TRAY_CANVAS_CONFIG = {
  WIDTH: 66,
  HEIGHT: 16,
  ICON_WIDTH: 16,
  ICON_HEIGHT: 16,
  TEXT_WIDTH: 46,
  TEXT_FONT_SIZE: 8
}
