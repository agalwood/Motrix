// A capsule has a flat center and a narrow curved rim. Encode the rim's
// inward sampling offset in R/G; neutral gray leaves the center undistorted.
export function createDisplacementMap(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  const radius = Math.min(width, height) / 2
  const rim = Math.min(5, radius / 3)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const dx = px - Math.max(radius, Math.min(width - radius, px))
      const dy = py - Math.max(radius, Math.min(height - radius, py))
      const distance = Math.hypot(dx, dy)
      const depth = radius - distance
      const bend = depth >= 0 && depth < rim ? (1 - depth / rim) ** 2 : 0
      const offset = (y * width + x) * 4
      pixels[offset] = 128 - (dx / (distance || 1)) * bend * 127
      pixels[offset + 1] = 128 - (dy / (distance || 1)) * bend * 127
      pixels[offset + 2] = 128
      pixels[offset + 3] = 255
    }
  }
  return pixels
}
