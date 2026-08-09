// Spec §9.5 I18: bridge classifies every injected method into either
// "registration-only" (allowed at module top-level during activation) or
// "effectful" (raises plugin.lifecycle.activation_capability_violation
// when called before the worker leaves module-evaluation phase).

export type Classification = 'registration-only' | 'effectful'

const REGISTRATION_ONLY: Record<string, ReadonlyArray<string>> = {
  hooks: ['beforeCreate', 'beforeFinalize', 'afterComplete', 'onError'],
  commands: ['register'],
  lifecycle: ['onActivate', 'onDeactivate'],
}

const EFFECTFUL: Record<string, ReadonlyArray<string>> = {
  http: ['request', 'get', 'post'],
  'fs.task': ['stat', 'exists', 'openReader', 'computeHash', 'rename'],
  'fs.storage': [
    'read',
    'write',
    'delete',
    'rename',
    'exists',
    'stat',
    'mkdir',
  ],
  storage: ['get', 'set', 'compareAndSet', 'delete', 'keys'],
  notify: ['show'],
  ffmpeg: [
    'probe',
    'transcode',
    'extractAudio',
    'mergeStreams',
    'generateThumbnail',
    'run',
  ],
  crypto: ['hash', 'hmac', 'randomBytes', 'aes'],
  config: ['get', 'getRaw', 'getAll', 'onChange'],
  commands: ['execute'],
  metadata: ['get', 'has', 'getAll', 'keys', 'set', 'delete'],
  app: [],
  i18n: ['t', 'on'],
  log: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
}

export function classify(capability: string, method: string): Classification {
  if (REGISTRATION_ONLY[capability]?.includes(method))
    return 'registration-only'
  if (EFFECTFUL[capability]?.includes(method)) return 'effectful'
  throw new Error(`unknown capability method: ${capability}.${method}`)
}

export function isRegistrationOnly(c: string, m: string): boolean {
  return classify(c, m) === 'registration-only'
}

export function isEffectful(c: string, m: string): boolean {
  return classify(c, m) === 'effectful'
}
