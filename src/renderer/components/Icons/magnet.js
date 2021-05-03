import Icon from '@/components/Icons/Icon'

Icon.register({
  'magnet': {
    'width': 24,
    'height': 24,
    'raw': `
      <line fill="none" stroke-miterlimit="10" x1="8.2" y1="4.5" x2="11.1" y2="7.3"></line>
      <line fill="none" stroke-miterlimit="10" x1="16.7" y1="12.9" x2="19.5" y2="15.8"></line>
      <path fill="none" stroke-miterlimit="10"
        d="M12.5,17.2 c-1.6,1.6-4.1,1.6-5.7,0c-1.6-1.6-1.6-4.1,0-5.7l7.1-7.1l-2.8-2.8L4,8.7C0.9,11.8,0.9,16.9,4,20s8.2,3.1,11.3,0l7.1-7.1l-2.8-2.8 L12.5,17.2z">
      </path>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
