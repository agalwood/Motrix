import {
  setRendererSurface,
  showRendererFailure,
  startRendererHealth,
} from './lib/renderer-health'

async function bootstrap(): Promise<void> {
  try {
    await startRendererHealth()
    const container = document.getElementById('root')
    if (!container) throw new Error('Renderer root is missing')
    const { startRenderer } = await import('./app-root')
    await startRenderer(container)
    if (__MOTRIX_TARGET__ === 'web') setRendererSurface('app')
  } catch {
    showRendererFailure('bootstrap')
  }
}
void bootstrap()
