import { I18N_RESOURCE_LOADERS } from '@shared/i18n-resources'

type AllResources = {
  [Locale in keyof typeof I18N_RESOURCE_LOADERS]: {
    translation: Awaited<
      ReturnType<(typeof I18N_RESOURCE_LOADERS)[Locale]>
    >['default']
  }
}

// Translation assertions intentionally preload every language; production does not.
export const I18N_RESOURCES = Object.fromEntries(
  await Promise.all(
    Object.entries(I18N_RESOURCE_LOADERS).map(async ([locale, load]) => [
      locale,
      { translation: (await load()).default },
    ])
  )
) as AllResources
