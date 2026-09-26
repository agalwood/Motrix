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

describe('bundled Korean translations', () => {
  it('resolves complete headings and other-only plurals without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'ko',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('다시 시도')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      '시스템 설정 따르기'
    )
    expect(i18n.t('panel.downloads.heading.all')).toBe('모든 다운로드')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      '다운로드 목록에서 “example.zip” 작업을 제거합니다.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe('다운로드한 파일 삭제')
    for (const count of [0, 1, 2, 5, 1.5, 1000000, 2000000]) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe('task.torrent.fileSelected_other')
      expect(result.res).toBe(`파일 ${count}개 선택됨`)
      expect(result.usedLng).toBe('ko')
    }
  })

  it('preserves the usage-notice highlights inside the Korean message', () => {
    const { disclaimer } = I18N_RESOURCES.ko.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Brazilian Portuguese translations', () => {
  it('resolves actions and all Brazilian plural categories without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'pt-BR',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Tentar novamente')
    expect(i18n.t('settings.appearance.followSystem')).toBe('Seguir o sistema')
    expect(i18n.t('panel.downloads.heading.all')).toBe('Todos os downloads')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      'A tarefa “example.zip” será removida da lista de downloads.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Excluir arquivos baixados'
    )
    for (const [count, category, text] of [
      [0, 'one', '0 arquivo selecionado'],
      [1, 'one', '1 arquivo selecionado'],
      [1.5, 'one', '1.5 arquivo selecionado'],
      [2, 'other', '2 arquivos selecionados'],
      [5, 'other', '5 arquivos selecionados'],
      [1000000, 'many', '1000000 arquivos selecionados'],
      [2000000, 'many', '2000000 arquivos selecionados'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('pt-BR')
    }
  })

  it('preserves the usage-notice highlights inside the Brazilian Portuguese message', () => {
    const { disclaimer } = I18N_RESOURCES['pt-BR'].translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Indonesian translations', () => {
  it('resolves complete headings and other-only plurals without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'id',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Coba lagi')
    expect(i18n.t('settings.appearance.followSystem')).toBe('Ikuti sistem')
    expect(i18n.t('panel.downloads.heading.all')).toBe('Semua unduhan')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      '“example.zip” akan dihapus dari daftar unduhan.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Hapus berkas yang telah diunduh'
    )
    for (const count of [0, 1, 2, 5, 1.5, 1000000, 2000000]) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe('task.torrent.fileSelected_other')
      expect(result.res).toBe(`${count} berkas dipilih`)
      expect(result.usedLng).toBe('id')
    }
  })

  it('preserves the usage-notice highlights inside the Indonesian message', () => {
    const { disclaimer } = I18N_RESOURCES.id.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Italian translations', () => {
  it('resolves actions and all Italian plural categories without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'it',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Riprova')
    expect(i18n.t('settings.appearance.followSystem')).toBe('Segui il sistema')
    expect(i18n.t('panel.downloads.heading.all')).toBe('Tutti i download')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      'L’attività “example.zip” verrà rimossa dall’elenco dei download.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Elimina i file scaricati'
    )
    for (const [count, category, text] of [
      [0, 'other', '0 file selezionati'],
      [1, 'one', '1 file selezionato'],
      [1.5, 'other', '1.5 file selezionati'],
      [2, 'other', '2 file selezionati'],
      [5, 'other', '5 file selezionati'],
      [1000000, 'many', '1000000 file selezionati'],
      [2000000, 'many', '2000000 file selezionati'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('it')
    }
  })

  it('preserves the usage-notice highlights inside the Italian message', () => {
    const { disclaimer } = I18N_RESOURCES.it.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Polish translations', () => {
  it('resolves actions and Polish singular, few, many and fractional forms without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'pl',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Spróbuj ponownie')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      'Zgodnie z systemem'
    )
    expect(i18n.t('panel.downloads.heading.all')).toBe('Wszystkie pobrania')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      'Zadanie „example.zip” zostanie usunięte z listy pobierania.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe('Usuń pobrane pliki')
    for (const [count, category, text] of [
      [0, 'many', 'Wybrano 0 plików'],
      [1, 'one', 'Wybrano 1 plik'],
      [2, 'few', 'Wybrano 2 pliki'],
      [4, 'few', 'Wybrano 4 pliki'],
      [5, 'many', 'Wybrano 5 plików'],
      [11, 'many', 'Wybrano 11 plików'],
      [12, 'many', 'Wybrano 12 plików'],
      [14, 'many', 'Wybrano 14 plików'],
      [21, 'many', 'Wybrano 21 plików'],
      [22, 'few', 'Wybrano 22 pliki'],
      [25, 'many', 'Wybrano 25 plików'],
      [1.5, 'other', 'Wybrano 1.5 pliku'],
      [1000000, 'many', 'Wybrano 1000000 plików'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('pl')
    }
  })

  it('preserves the usage-notice highlights inside the Polish message', () => {
    const { disclaimer } = I18N_RESOURCES.pl.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Russian translations', () => {
  it('resolves actions and Russian singular, few, many and fractional forms without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'ru',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Повторить')
    expect(i18n.t('settings.appearance.followSystem')).toBe('Как в системе')
    expect(i18n.t('panel.downloads.heading.all')).toBe('Все загрузки')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      'Задача «example.zip» будет удалена из списка загрузок.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'Удалить скачанные файлы'
    )
    for (const [count, category, text] of [
      [0, 'many', 'Выбрано 0 файлов'],
      [1, 'one', 'Выбран 1 файл'],
      [2, 'few', 'Выбрано 2 файла'],
      [4, 'few', 'Выбрано 4 файла'],
      [5, 'many', 'Выбрано 5 файлов'],
      [11, 'many', 'Выбрано 11 файлов'],
      [12, 'many', 'Выбрано 12 файлов'],
      [14, 'many', 'Выбрано 14 файлов'],
      [21, 'one', 'Выбран 21 файл'],
      [22, 'few', 'Выбрано 22 файла'],
      [25, 'many', 'Выбрано 25 файлов'],
      [101, 'one', 'Выбран 101 файл'],
      [111, 'many', 'Выбрано 111 файлов'],
      [1.5, 'other', 'Выбрано 1.5 файла'],
      [1000000, 'many', 'Выбрано 1000000 файлов'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(text)
      expect(result.usedLng).toBe('ru')
    }
  })

  it('preserves the usage-notice highlights inside the Russian message', () => {
    const { disclaimer } = I18N_RESOURCES.ru.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Turkish translations', () => {
  it('resolves actions and Turkish plural forms without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'tr',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Yeniden dene')
    expect(i18n.t('settings.appearance.followSystem')).toBe(
      'Sistem dilini kullan'
    )
    expect(i18n.t('panel.downloads.heading.all')).toBe('Tüm İndirmeler')
    expect(i18n.t('panel.downloads.action.remove')).toBe('Listeden kaldır')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      '“example.zip” indirme listesinden kaldırılacak.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe(
      'İndirilen dosyaları sil'
    )
    for (const [count, category] of [
      [0, 'other'],
      [1, 'one'],
      [2, 'other'],
      [5, 'other'],
      [11, 'other'],
      [21, 'other'],
      [1.5, 'other'],
      [1000000, 'other'],
    ] as const) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe(`task.torrent.fileSelected_${category}`)
      expect(result.res).toBe(`${count} dosya seçildi`)
      expect(result.usedLng).toBe('tr')
    }
  })

  it('preserves the usage-notice highlights inside the Turkish message', () => {
    const { disclaimer } = I18N_RESOURCES.tr.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

describe('bundled Vietnamese translations', () => {
  it('resolves actions and other-only plurals without English fallback', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'vi',
      fallbackLng: false,
      resources: I18N_RESOURCES,
      interpolation: { escapeValue: false },
    })

    expect(i18n.t('common.retry')).toBe('Thử lại')
    expect(i18n.t('settings.appearance.followSystem')).toBe('Theo hệ thống')
    expect(i18n.t('panel.downloads.heading.all')).toBe('Tất cả lượt tải xuống')
    expect(i18n.t('panel.downloads.action.remove')).toBe('Xóa khỏi danh sách')
    expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
      '“example.zip” sẽ bị xóa khỏi danh sách tải xuống.'
    )
    expect(i18n.t('task.remove.deleteFilesLabel')).toBe('Xóa tệp đã tải xuống')
    for (const count of [0, 1, 2, 5, 1.5, 1000000, 2000000]) {
      const result = i18n.t('task.torrent.fileSelected', {
        count,
        returnDetails: true,
      })
      expect(result.exactUsedKey).toBe('task.torrent.fileSelected_other')
      expect(result.res).toBe(`Đã chọn ${count} tệp`)
      expect(result.usedLng).toBe('vi')
    }
  })

  it('preserves the usage-notice highlights inside the Vietnamese message', () => {
    const { disclaimer } = I18N_RESOURCES.vi.translation.onboarding
    for (const highlight of Object.values(disclaimer.highlights)) {
      expect(disclaimer.body).toContain(highlight)
    }
    expect(disclaimer.body).toContain(disclaimer.agree)
  })
})

const expandedLocaleCases = [
  {
    locale: 'ar',
    retry: 'إعادة المحاولة',
    followSystem: 'اتباع النظام',
    remove: 'ستُزال «example.zip» من قائمة التنزيلات.',
    deleteFiles: 'حذف الملفات المنزّلة',
    samples: [
      [0, 'zero', 'الملفات المحددة: 0'],
      [1, 'one', 'الملفات المحددة: 1'],
      [2, 'two', 'الملفات المحددة: 2'],
      [3, 'few', 'الملفات المحددة: 3'],
      [11, 'many', 'الملفات المحددة: 11'],
      [100, 'other', 'الملفات المحددة: 100'],
      [1.5, 'other', 'الملفات المحددة: 1.5'],
    ],
  },
  {
    locale: 'bg',
    retry: 'Повторен опит',
    followSystem: 'Следване на системния език',
    remove:
      'Задачата „example.zip“ ще бъде премахната от списъка с изтегляния.',
    deleteFiles: 'Изтриване на изтеглените файлове',
    samples: [
      [0, 'other', 'Избрани са 0 файла'],
      [1, 'one', 'Избран е 1 файл'],
      [2, 'other', 'Избрани са 2 файла'],
      [1.5, 'other', 'Избрани са 1.5 файла'],
    ],
  },
  {
    locale: 'ca',
    retry: 'Tornar-ho a provar',
    followSystem: 'Seguir el sistema',
    remove: 'La tasca «example.zip» se suprimirà de la llista de baixades.',
    deleteFiles: 'Eliminar els fitxers baixats',
    samples: [
      [0, 'other', '0 fitxers seleccionats'],
      [1, 'one', '1 fitxer seleccionat'],
      [2, 'other', '2 fitxers seleccionats'],
      [1000000, 'many', '1000000 fitxers seleccionats'],
    ],
  },
  {
    locale: 'el',
    retry: 'Επανάληψη',
    followSystem: 'Σύμφωνα με το σύστημα',
    remove: 'Η εργασία «example.zip» θα αφαιρεθεί από τη λίστα λήψεων.',
    deleteFiles: 'Διαγραφή ληφθέντων αρχείων',
    samples: [
      [0, 'other', 'Επιλέχθηκαν 0 αρχεία'],
      [1, 'one', 'Επιλέχθηκε 1 αρχείο'],
      [2, 'other', 'Επιλέχθηκαν 2 αρχεία'],
      [1.5, 'other', 'Επιλέχθηκαν 1.5 αρχεία'],
    ],
  },
  {
    locale: 'fa',
    retry: 'تلاش دوباره',
    followSystem: 'پیروی از سیستم',
    remove: '«example.zip» از فهرست دانلودها حذف می‌شود.',
    deleteFiles: 'حذف فایل‌های دانلودشده',
    samples: [
      [0, 'one', '0 فایل انتخاب شده'],
      [0.5, 'one', '0.5 فایل انتخاب شده'],
      [1, 'one', '1 فایل انتخاب شده'],
      [2, 'other', '2 فایل انتخاب شده'],
    ],
  },
  {
    locale: 'nb',
    retry: 'Prøv igjen',
    followSystem: 'Følg systemet',
    remove: '«example.zip» fjernes fra nedlastingslisten.',
    deleteFiles: 'Slett nedlastede filer',
    samples: [
      [0, 'other', '0 filer valgt'],
      [1, 'one', '1 fil valgt'],
      [2, 'other', '2 filer valgt'],
      [1.5, 'other', '1.5 filer valgt'],
    ],
  },
  {
    locale: 'nl',
    retry: 'Opnieuw proberen',
    followSystem: 'Systeem volgen',
    remove: '‘example.zip’ wordt uit de downloadlijst verwijderd.',
    deleteFiles: 'Gedownloade bestanden verwijderen',
    samples: [
      [0, 'other', '0 bestanden geselecteerd'],
      [1, 'one', '1 bestand geselecteerd'],
      [2, 'other', '2 bestanden geselecteerd'],
      [1.5, 'other', '1.5 bestanden geselecteerd'],
    ],
  },
  {
    locale: 'ro',
    retry: 'Încearcă din nou',
    followSystem: 'Urmează sistemul',
    remove: 'Sarcina „example.zip” va fi eliminată din lista de descărcări.',
    deleteFiles: 'Șterge fișierele descărcate',
    samples: [
      [0, 'few', '0 fișiere selectate'],
      [1, 'one', '1 fișier selectat'],
      [2, 'few', '2 fișiere selectate'],
      [20, 'other', '20 de fișiere selectate'],
      [101, 'few', '101 fișiere selectate'],
      [1.5, 'few', '1.5 fișiere selectate'],
    ],
  },
  {
    locale: 'th',
    retry: 'ลองอีกครั้ง',
    followSystem: 'ตามระบบ',
    remove: '“example.zip” จะถูกนำออกจากรายการดาวน์โหลด',
    deleteFiles: 'ลบไฟล์ที่ดาวน์โหลด',
    samples: [
      [0, 'other', 'เลือก 0 ไฟล์แล้ว'],
      [1, 'other', 'เลือก 1 ไฟล์แล้ว'],
      [2, 'other', 'เลือก 2 ไฟล์แล้ว'],
    ],
  },
  {
    locale: 'uk',
    retry: 'Спробувати ще раз',
    followSystem: 'Як у системі',
    remove: 'Завдання «example.zip» буде прибрано зі списку завантажень.',
    deleteFiles: 'Видалити завантажені файли',
    samples: [
      [0, 'many', 'Вибрано 0 файлів'],
      [1, 'one', 'Вибрано 1 файл'],
      [2, 'few', 'Вибрано 2 файли'],
      [5, 'many', 'Вибрано 5 файлів'],
      [11, 'many', 'Вибрано 11 файлів'],
      [21, 'one', 'Вибрано 21 файл'],
      [1.5, 'other', 'Вибрано 1.5 файлу'],
    ],
  },
] as const

describe.each(expandedLocaleCases)(
  'bundled $locale translations',
  ({ locale, retry, followSystem, remove, deleteFiles, samples }) => {
    it('resolves actions and each plural category without English fallback', async () => {
      const i18n = createInstance()
      await i18n.init({
        lng: locale,
        fallbackLng: false,
        resources: I18N_RESOURCES,
        interpolation: { escapeValue: false },
      })
      expect(i18n.t('common.retry')).toBe(retry)
      expect(i18n.t('settings.appearance.followSystem')).toBe(followSystem)
      expect(i18n.t('task.remove.description', { name: 'example.zip' })).toBe(
        remove
      )
      expect(i18n.t('task.remove.deleteFilesLabel')).toBe(deleteFiles)
      for (const [count, category, text] of samples) {
        const result = i18n.t('task.torrent.fileSelected', {
          count,
          returnDetails: true,
        })
        expect(result.exactUsedKey).toBe(
          `task.torrent.fileSelected_${category}`
        )
        expect(result.res).toBe(text)
        expect(result.usedLng).toBe(locale)
      }
    })

    it('keeps usage-notice highlights and consent inside the complete message', () => {
      const { disclaimer } = I18N_RESOURCES[locale].translation.onboarding
      for (const highlight of Object.values(disclaimer.highlights))
        expect(disclaimer.body).toContain(highlight)
      expect(disclaimer.body).toContain(disclaimer.agree)
    })
  }
)
