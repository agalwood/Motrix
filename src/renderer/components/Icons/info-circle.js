import Icon from '@/components/Icons/Icon'

Icon.register({
  'info-circle': {
    'width': 24,
    'height': 24,
    'raw': `<circle cx="12" cy="12" r="11" fill="none" stroke-miterlimit="10"/>
      <line data-color="color-2" x1="11.959" y1="11" x2="11.959" y2="17" fill="none" stroke-miterlimit="10"/>
      <circle data-color="color-2" data-stroke="none" cx="11.959" cy="7" r="1" stroke="none"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
