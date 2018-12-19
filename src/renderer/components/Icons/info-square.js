import Icon from '@/components/Icons/Icon'

Icon.register({
  'info-square': {
    'width': 24,
    'height': 24,
    'raw': `<rect x="2" y="2" width="20" height="20" fill="none" stroke-miterlimit="10"/>
      <line data-color="color-2" x1="12" y1="11" x2="12" y2="17" fill="none" stroke-miterlimit="10"/>
      <circle data-color="color-2" data-stroke="none" cx="12" cy="7" r="1" stroke="none"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
