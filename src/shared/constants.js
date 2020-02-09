export const EMPTY_STRING = ''

export const LIGHT_THEME = 'light'
export const DARK_THEME = 'dark'

export const APP_RUN_MODE = {
  STANDARD: 1,
  MENU_BAR: 2
}

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

// One Week
export const AUTO_CHECK_UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000

export const NONE_SELECTED_FILES = 'none'
export const SELECTED_ALL_FILES = 'all'
