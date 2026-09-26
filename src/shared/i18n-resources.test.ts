import { I18N_RESOURCES } from '@shared/i18n-resources'
import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

describe('bundled German translations', () => {
  it('resolves actions and German plural forms without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'de',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Erneut versuchen')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      'Systemsprache verwenden'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Heruntergeladene Dateien löschen'
    )
    for (const [count, category, text] of [
      [0, 'other', '0 Dateien ausgewählt'],
      [1, 'one', '1 Datei ausgewählt'],
      [2, 'other', '2 Dateien ausgewählt'],
      [1.5, 'other', '1.5 Dateien ausgewählt'],
      [1000000, 'other', '1000000 Dateien ausgewählt'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('de')
    }
  })

  it('preserves the usage-notice highlights inside the German message', () => {
    const { disclaimer } = I18N_RESOURCES.de.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Spanish translations', () => {
  it('resolves actions and all Spanish plural categories without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'es',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Reintentar')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      'Usar idioma del sistema'
    )
    expect(i18n.t('panel.downloads.action.remove')).toBe('Quitar')
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Eliminar archivos descargados'
    )
    for (const [count, category, text] of [
      [0, 'other', '0 archivos seleccionados'],
      [1, 'one', '1 archivo seleccionado'],
      [2, 'other', '2 archivos seleccionados'],
      [1.5, 'other', '1.5 archivos seleccionados'],
      [1000000, 'many', '1000000 archivos seleccionados'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('es')
    }
  })

  it('preserves the usage-notice highlights inside the Spanish message', () => {
    const { disclaimer } = I18N_RESOURCES.es.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

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

describe('bundled Japanese translations', () => {
  it('resolves complete headings and other-only plurals without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'ja',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('再試行')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      'システムに合わせる'
    )
    expect(i18n.t('panel.downloads.heading.all')).toBe('すべてのダウンロード')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      '「example.zip」をダウンロード一覧から削除します。'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'ダウンロードしたファイルを削除'
    )
    for (const count of [0, 1, 2, 5, 1.5, 1000000, 2000000]) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe('task.torrent.fileSelected_other')
      expect(result.res).toBe(`${count} 個のファイルを選択`)
      expect(result.usedLng).toBe('ja')
    }
  })

  it('preserves the usage-notice highlights inside the Japanese message', () => {
    const { disclaimer } = I18N_RESOURCES.ja.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})
