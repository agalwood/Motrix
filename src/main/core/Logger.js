import { join } from 'node:path'
import is from 'electron-is'
import logger from 'electron-log'

import { IS_PORTABLE, PORTABLE_EXECUTABLE_DIR } from '@shared/constants'

const level = is.production() ? 'info' : 'silly'
logger.transports.file.level = level

if (IS_PORTABLE) {
  logger.transports.file.resolvePath = () => join(PORTABLE_EXECUTABLE_DIR, 'main.log')
}

logger.info('[Motrix] Logger init')
logger.warn('[Motrix] Logger init')

export default logger
