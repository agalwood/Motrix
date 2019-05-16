import Icon from '@/components/Icons/Icon'

Icon.register({
  'audio': {
    'width': 24,
    'height': 24,
    'raw': `<rect x="4" y="3" width="16" height="18" fill="none" stroke="currentColor" stroke-miterlimit="10"/>
      <line data-color="color-2" x1="1" y1="6" x2="1" y2="18" fill="none" stroke-miterlimit="10"/>
      <line data-color="color-2" x1="23" y1="6" x2="23" y2="18" fill="none" stroke-miterlimit="10"/>
      <polyline data-cap="butt" points="10 15 10 8 16 8 16 14" fill="none" stroke="currentColor" stroke-miterlimit="10"/>
      <circle data-stroke="none" cx="9" cy="15" r="2" stroke="none"/>
      <circle data-stroke="none" cx="15" cy="14" r="2" stroke="none"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
