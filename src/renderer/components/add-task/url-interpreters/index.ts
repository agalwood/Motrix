import { curlInterpreter } from './curl'
import { magnetLineInterpreter } from './magnet-line'
import { multilineUrlInterpreter } from './multiline-url'
import type { UrlInputInterpreter } from './types'

export const builtinInterpreters: UrlInputInterpreter[] = [
  curlInterpreter,
  magnetLineInterpreter,
  multilineUrlInterpreter,
].sort((a, b) => a.priority - b.priority)
