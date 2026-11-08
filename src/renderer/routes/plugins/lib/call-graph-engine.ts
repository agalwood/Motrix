import type { ElkNode } from 'elkjs'
import ELK from 'elkjs/lib/elk-api.js'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import type { ElkLayoutAdapter } from './call-graph-layout'

const REQUEST_TIMEOUT_MS = 30_000

// Keep parsing and layout off the renderer thread. The bundled ELK entry point
// otherwise supplies a FakeWorker that executes expensive work on that thread.
export async function createCallGraphEngine(
  onFailure: () => void
): Promise<ElkLayoutAdapter> {
  const worker = new ElkWorker()
  const pending = new Set<(error: Error) => void>()
  let failure: Error | undefined
  const fail = (error: Error) => {
    if (failure) return
    failure = error
    worker.removeEventListener('error', handleError)
    worker.removeEventListener('messageerror', handleMessageError)
    worker.terminate()
    for (const reject of pending) reject(error)
    onFailure()
  }
  const handleError = (event: ErrorEvent) => {
    event.preventDefault()
    fail(new Error(event.message || 'Call graph worker failed'))
  }
  const handleMessageError = () => {
    fail(new Error('Call graph worker returned an unreadable message'))
  }
  worker.addEventListener('error', handleError)
  worker.addEventListener('messageerror', handleMessageError)

  function request<T>(run: () => Promise<T>): Promise<T> {
    if (failure) return Promise.reject(failure)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error('Call graph worker timed out')),
        REQUEST_TIMEOUT_MS
      )
      const rejectRequest = (error: Error) => {
        clearTimeout(timer)
        pending.delete(rejectRequest)
        reject(error)
      }
      pending.add(rejectRequest)
      Promise.resolve()
        .then(run)
        .then((value) => {
          clearTimeout(timer)
          pending.delete(rejectRequest)
          resolve(value)
        }, rejectRequest)
    })
  }

  try {
    const elk = new ELK({
      workerFactory: () => worker,
      algorithms: ['layered'],
    })
    // Exercise the algorithm as well as worker registration before declaring it
    // warm. Use a tiny graph so speculative work has a bounded input size.
    await request(() =>
      elk.layout({
        id: 'warmup',
        layoutOptions: { 'elk.algorithm': 'layered' },
        children: [
          { id: 'a', width: 1, height: 1 },
          { id: 'b', width: 1, height: 1 },
        ],
        edges: [{ id: 'ab', sources: ['a'], targets: ['b'] }],
      })
    )
    return { layout: (graph: ElkNode) => request(() => elk.layout(graph)) }
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
