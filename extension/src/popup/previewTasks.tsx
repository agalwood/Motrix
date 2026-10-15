import type { MdxpTask } from '@motrix/mdxp'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export const PREVIEW_TASK_DATASETS = [
  ['demo', 'Demo data'],
  ['worst', 'Worst case'],
  ['empty', 'Empty'],
  ['one', 'One'],
  ['many', '1,000 rows'],
] as const
export type PreviewTaskDataset = (typeof PREVIEW_TASK_DATASETS)[number][0]

export function resolvePreviewTaskDataset(value: string | null) {
  return PREVIEW_TASK_DATASETS.find(([key]) => key === value)?.[0] ?? null
}

const WORST_TASK_NAMES = [
  'The.Complete.Open.Source.Documentary.Collection.2026.2160p.UHD.BluRay.REMUX.HDR10Plus.DolbyVision.HEVC.DTSHDMA.7.1.MultiAudio.English.German.French.TraditionalChinese.Spanish.Subtitles.ArchivalEdition.Part01.mkv',
  'Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf',
  'J',
  '王秀英的臺灣旅行紀錄與家庭照片備份_完整版_高畫質_原始檔案_最終修訂版.zip',
  '👩🏽‍💻 Đặng Thị Ngọc Hân — ภาพถ่ายวันหยุด.heic',
  'أرشيف الصور العائلية — النسخة النهائية.zip',
  '<b>Annual report</b> & notes.txt',
  '',
] as const
const WORST_TASK_STATUSES: readonly MdxpTask['status'][] = [
  'downloading',
  'paused',
  'fetching_metadata',
  'seeding',
  'finalizing',
  'queued',
  'error',
  'completed',
]

function previewTask(
  index: number,
  name: string,
  status: MdxpTask['status'] = 'downloading'
): MdxpTask {
  return {
    id: `preview-task-${index}`,
    type: index === 0 ? 'magnet' : 'http',
    name,
    status,
    progress: status === 'completed' ? 1 : 0.5,
    bytesDone: 512 * 1024 * 1024,
    bytesTotal: status === 'fetching_metadata' ? null : 1024 * 1024 * 1024,
    speedBps: status === 'downloading' ? 2048 * 1024 : 0,
    etaSec: null,
    saveDir: '/downloads',
    error: status === 'error' ? 'The download source is unavailable.' : null,
    createdAt: 1_791_532_800_000 - index,
    finishedAt: status === 'completed' ? 1_791_532_800_000 : null,
    finalPath: status === 'completed' ? `/downloads/${name}` : null,
  }
}

/** Local preview fixtures enter through the same task/list boundary as real data. */
export function createPreviewTasks(
  dataset: PreviewTaskDataset | null
): MdxpTask[] {
  if (dataset === null || dataset === 'empty') return []
  if (dataset === 'worst') {
    return WORST_TASK_NAMES.map((name, index) =>
      previewTask(index, name, WORST_TASK_STATUSES[index])
    )
  }
  if (dataset === 'many') {
    return Array.from({ length: 1000 }, (_, index) =>
      previewTask(index, `Archive-${index + 1}.zip`)
    )
  }
  if (dataset === 'one') return [previewTask(0, 'archive.zip')]
  return [
    previewTask(0, 'archive.zip'),
    previewTask(1, 'photo.heic', 'error'),
    previewTask(2, 'report.pdf', 'completed'),
  ]
}

/** This control is imported only by popup-preview.html, never the extension entry. */
export function PreviewTaskDataControl({
  initialDataset,
  onChange,
}: {
  initialDataset: PreviewTaskDataset
  onChange: (dataset: PreviewTaskDataset) => void
}) {
  const [dataset, setDataset] = useState(initialDataset)
  return (
    <fieldset
      aria-label="Preview task data"
      dir="ltr"
      className="fixed bottom-0 left-1/2 z-40 flex max-w-full -translate-x-1/2 gap-0.5 rounded-md bg-muted p-0.5 font-sans"
    >
      {PREVIEW_TASK_DATASETS.map(([key, label]) => (
        <Button
          key={key}
          size="xs"
          variant={dataset === key ? 'outline' : 'ghost'}
          className="h-auto min-h-6 min-w-0 shrink px-1 text-[10px] whitespace-normal"
          aria-pressed={dataset === key}
          onClick={() => {
            setDataset(key)
            const url = new URL(window.location.href)
            url.searchParams.set('data', key)
            window.history.replaceState(null, '', url)
            onChange(key)
          }}
        >
          {label}
        </Button>
      ))}
    </fieldset>
  )
}
