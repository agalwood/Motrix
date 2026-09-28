// JSDOM has no Web Animations implementation. Base UI checks for active
// animations when measuring scroll areas; there are none in this environment.
if (typeof Element !== 'undefined' && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}
