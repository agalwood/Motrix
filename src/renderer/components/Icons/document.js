import Icon from '@/components/Icons/Icon'

Icon.register({
  'document': {
    'width': 24,
    'height': 24,
    'raw': `<rect x="3" y="1" width="18" height="22"></rect>
      <line x1="15" y1="6" x2="17" y2="6"></line>
      <line x1="15" y1="10" x2="17" y2="10"></line>
      <line x1="7" y1="14" x2="17" y2="14"></line>
      <line x1="7" y1="18" x2="17" y2="18"></line>
      <rect x="7" y="6" width="4" height="4"></rect>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2',
      'fill': 'none'
    }
  }
})
