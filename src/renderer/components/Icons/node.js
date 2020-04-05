import Icon from '@/components/Icons/Icon'

Icon.register({
  'node': {
    'width': 24,
    'height': 24,
    'raw': `
      <polyline data-cap="butt" fill="none" stroke-miterlimit="10" points="12,9 12,13 7.8,16.1 "/>
      <line data-cap="butt" fill="none" stroke-miterlimit="10" x1="12" y1="13" x2="16.2" y2="16.1"/>
      <circle fill="none" stroke="currentColor" stroke-miterlimit="10" cx="12" cy="5" r="4"/>
      <circle fill="none" stroke="currentColor" stroke-miterlimit="10" cx="5" cy="19" r="4"/>
      <circle fill="none" stroke="currentColor" stroke-miterlimit="10" cx="19" cy="19" r="4"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
