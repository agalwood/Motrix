import { z } from 'zod'

const httpHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
})

/** Request payload for `Commands.ParsePageLinks`. */
export const parsePageLinksRequestSchema = z.object({
  url: z.url(),
  headers: z.array(httpHeaderSchema).default([]),
  proxy: z.string().optional(),
})
export type ParsePageLinksRequest = z.infer<typeof parsePageLinksRequestSchema>

/** One downloadable resource discovered on a parsed page. */
export const pageLinkResourceSchema = z.object({
  /** 0-based index used by the add-task file selection UI. */
  index: z.number().int().nonnegative(),
  /** Absolute http(s) URL of the resource. */
  url: z.string(),
  /** Sanitized display/download filename. */
  filename: z.string().min(1),
  /** Extension with dot, e.g. `.mp4`; empty when none. */
  extension: z.string(),
  /** Unknown without a HEAD probe; AutoParser deliberately skips probing. */
  size: z.number().int().nonnegative().nullable(),
})
export type PageLinkResource = z.infer<typeof pageLinkResourceSchema>

export const parsePageLinksResultSchema = z.object({
  /** The URL the user submitted. */
  pageUrl: z.string(),
  /** URL after redirects; equals `pageUrl` when none were followed. */
  finalUrl: z.string(),
  title: z.string().nullable(),
  links: z.array(pageLinkResourceSchema),
})
export type ParsePageLinksResult = z.infer<typeof parsePageLinksResultSchema>