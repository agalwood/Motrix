import Icon from '@/components/Icons/Icon'

Icon.register({
  'inbox': {
    'width': 24,
    'height': 24,
    'raw': `<polyline data-cap="butt" fill="none" stroke-miterlimit="10" points="23,15 16,15 16,18 8,18 8,15 1,15 "/>
      <line data-cap="butt" fill="none" stroke-miterlimit="10" x1="12" y1="1" x2="12" y2="11"/>
      <polyline fill="none" stroke-miterlimit="10" points="19,6 20,6 23,15 23,23 1,23 1,15 4,6 5,6 "/>
      <polyline fill="none" stroke-miterlimit="10" points=" 15,8 12,11 9,8 "/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '1.5'
    }
  }
})
