import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import { z } from 'zod'

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALE_CODES)
