import Icon from '@/components/Icons/Icon'

Icon.register({
  'dice': {
    'width': 24,
    'height': 24,
    'raw': `<polyline data-cap="butt" fill="none" stroke="currentColor" stroke-miterlimit="10" points="17,23 17,7 1,7 "/>
      <line data-cap="butt" fill="none" stroke="currentColor" stroke-miterlimit="10" x1="17" y1="7" x2="23" y2="1"/>
      <polygon fill="none" stroke="currentColor" stroke-miterlimit="10" points="17,23 23,17 23,1 7,1 1,7 1,23 "/>
      <circle data-color="color-2" data-stroke="none" cx="12" cy="12" r="1" stroke-linejoin="miter" stroke-linecap="square" stroke="none"/>
      <circle data-color="color-2" data-stroke="none" cx="6" cy="12" r="1" stroke-linejoin="miter" stroke-linecap="square" stroke="none"/>
      <circle data-color="color-2" data-stroke="none" cx="12" cy="18" r="1" stroke-linejoin="miter" stroke-linecap="square" stroke="none"/>
      <circle data-color="color-2" data-stroke="none" cx="6" cy="18" r="1" stroke-linejoin="miter" stroke-linecap="square" stroke="none"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
