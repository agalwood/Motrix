import is from 'electron-is'
import logger from 'electron-log'

logger.transports.file.level = is.production() ? 'warn' : 'silly'
logger.info('[Motrix] Logger init')
logger.warn('[Motrix] Logger init')

export default logger
