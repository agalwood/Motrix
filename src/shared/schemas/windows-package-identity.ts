import { z } from 'zod'

// Package strings and publisher IDs are ASCII; their ordinal comparisons are
// case-insensitive. The publisher's certificate subject remains case-sensitive.
// https://learn.microsoft.com/windows/apps/desktop/modernize/package-identity-overview
const PackageNameSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[A-Za-z0-9.-]+$/)
const PublisherSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\p{Cc}\p{Cs}]+$/u)
const PublisherIdSchema = z.string().regex(/^[a-hjkmnp-tv-z0-9]{13}$/i)
const FamilyNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9.-]{3,50}_[a-hjkmnp-tv-z0-9]{13}$/i)
const ResourceIdSchema = z
  .string()
  .max(30)
  .regex(/^[A-Za-z0-9.-]*$/)
const PackageVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((value) => value.split('.').every((part) => Number(part) <= 65535))
const ArchitectureSchema = z.enum([
  'x86',
  'x64',
  'arm',
  'arm64',
  'neutral',
  'x86a64',
])

export const WindowsPackageIdentitySchema = z
  .object({
    name: PackageNameSchema,
    publisher: PublisherSchema,
    publisherId: PublisherIdSchema,
    familyName: FamilyNameSchema,
    fullName: z.string().min(1).max(256),
    version: PackageVersionSchema,
    architecture: ArchitectureSchema,
    resourceId: ResourceIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const family = `${value.name}_${value.publisherId}`
    const full = `${value.name}_${value.version}_${value.architecture}_${value.resourceId}_${value.publisherId}`
    for (const [field, expected] of [
      ['familyName', family],
      ['fullName', full],
    ] as const) {
      if (value[field].toLowerCase() !== expected.toLowerCase()) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Inconsistent package identity',
        })
      }
    }
  })

export const WindowsPackageExpectationSchema = z
  .object({
    name: PackageNameSchema,
    publisher: PublisherSchema,
    familyName: FamilyNameSchema,
    version: PackageVersionSchema,
    architecture: ArchitectureSchema,
    resourceId: ResourceIdSchema,
  })
  .strict()
  .refine((value) =>
    value.familyName.toLowerCase().startsWith(`${value.name.toLowerCase()}_`)
  )

export const WindowsPackageIdentityRequestSchema = z
  .object({
    version: z.literal(1),
    op: z.literal('package_identity_query'),
  })
  .strict()

export const WindowsPackageIdentityResponseSchema = z.union([
  z
    .object({
      version: z.literal(1),
      ok: z.literal(true),
      packageIdentityPresent: z.literal(true),
      identity: WindowsPackageIdentitySchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      ok: z.literal(false),
      code: z.enum([
        'invalid_request',
        'no_package_identity',
        'package_identity_unavailable',
        'winrt_failed',
      ]),
      hresult: z
        .string()
        .regex(/^0x[0-9a-f]{8}$/)
        .optional(),
    })
    .strict(),
])

export type WindowsPackageIdentity = z.infer<
  typeof WindowsPackageIdentitySchema
>
