import { curlInterpreter } from './curl'
import { jsonInterpreter } from './json'
import { magnetLineInterpreter } from './magnet-line'
import { multilineUrlInterpreter } from './multiline-url'
import type { UrlInputInterpreter } from './types'

export const builtinInterpreters: UrlInputInterpreter[] = [
  curlInterpreter,
  jsonInterpreter,
  magnetLineInterpreter,
  multilineUrlInterpreter,
].sort((a, b) => a.priority - b.priority)
