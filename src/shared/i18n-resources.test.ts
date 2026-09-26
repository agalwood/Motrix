import { I18N_RESOURCES } from '@shared/i18n-resources'
import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

describe('bundled French translations', () => {
  it('resolves actions and all French plural categories without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'fr',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Réessayer')
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Supprimer les fichiers téléchargés'
    )
    for (const [count, category, text] of [
      [0, 'one', '0 fichier sélectionné'],
      [1, 'one', '1 fichier sélectionné'],
      [2, 'other', '2 fichiers sélectionnés'],
      [1000000, 'many', '1000000 fichiers sélectionnés'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('fr')
    }
  })

  it('preserves the translated usage-notice highlights inside the full message', () => {
    const { disclaimer } = I18N_RESOURCES.fr.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})
