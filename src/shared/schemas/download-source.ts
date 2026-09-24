import { z } from 'zod'

export const MAX_DOWNLOAD_URL_BYTES = 16 * 1024
export const MAX_MIRROR_URIS = 128
export const MAX_DOWNLOAD_INPUT_LINES = 1000
export const MAX_DOWNLOAD_INPUT_BYTES = 1024 * 1024

export const sourceProtocolSchema = z.enum(['http', 'https', 'ftp', 'magnet'])
export const sourceReasonSchema = z.enum([
  'missingScheme',
  'invalidHost',
  'invalidPort',
  'controlCharacter',
  'invalidUnicode',
  'ambiguousBackslash',
  'invalidPercentEncoding',
  'credentialsInUrl',
  'unsupportedProtocol',
  'urlTooLong',
  'tooManySources',
  'ambiguousStructure',
  'unescapedCharacter',
  'invalidMagnet',
  'mixedProtocols',
  'unsupportedInput',
  'unsupportedRequestOptions',
])
export const sourceDiagnosticSchema = z.object({
  reason: sourceReasonSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})
export const sourceCorrectionSchema = z.object({
  action: z.enum([
    'useCanonicalUrl',
    'usePathSeparators',
    'encodeLiteralCharacters',
  ]),
  url: z.string(),
})
export const downloadSourceAnalysisSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    protocol: sourceProtocolSchema,
    sourceUrl: z.string(),
    requestUrl: z.string(),
    host: z.string(),
  }),
  z.object({
    status: z.literal('needsCorrection'),
    diagnostic: sourceDiagnosticSchema,
    corrections: z.array(sourceCorrectionSchema),
  }),
  z.object({
    status: z.literal('rejected'),
    diagnostic: sourceDiagnosticSchema,
  }),
])
export const sourceFailureSchema = z.object({
  stage: z.enum(['input', 'plugin', 'resolution', 'engine', 'recovery']),
  index: z.number().int().nonnegative(),
  diagnostic: sourceDiagnosticSchema,
})
export type SourceProtocol = z.infer<typeof sourceProtocolSchema>
export type SourceReason = z.infer<typeof sourceReasonSchema>
export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>
export type SourceCorrection = z.infer<typeof sourceCorrectionSchema>
export type DownloadSourceAnalysis = z.infer<
  typeof downloadSourceAnalysisSchema
>
export type AcceptedDownloadSource = Extract<
  DownloadSourceAnalysis,
  { status: 'accepted' }
>
export type SourceFailure = z.infer<typeof sourceFailureSchema>
