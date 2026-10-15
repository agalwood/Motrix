import { execFile } from 'node:child_process'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Page } from '@playwright/test'
import { Queries } from '@shared/protocol/queries'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import {
  type DownloadTask,
  TaskKind,
  TaskStatus,
} from '../src/shared/types/task'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

/**
 * Live yt-dlp media download acceptance.
 *
 * Opt-in because it needs the yt-dlp and FFmpeg binaries plus outbound
 * network access to a real video site (YouTube), so it never runs in the
 * hermetic CI suite:
 *
 *   MOTRIX_LIVE_NETWORK_TESTS=1 pnpm exec playwright test \
 *     e2e/media-download.spec.ts --headed
 *
 * The desktop Add-Task path resolves media through the shell yt-dlp resolver
 * and, for an adaptive pair, muxes it with FFmpeg. The per-task quality
 * selector belongs to the browser extension's grab overlay, so the desktop
 * format lever is the global `media.ytdlpFormat` setting — each test seeds a
 * different selector before launch and downloads a real video end to end.
 */

const execFileAsync = promisify(execFile)

const liveNetwork = process.env.MOTRIX_LIVE_NETWORK_TESTS === '1'
const ytdlpBinary = process.env.MOTRIX_YT_DLP_PATH?.trim() || 'yt-dlp'
const ffprobeBinary = process.env.MOTRIX_FFPROBE_PATH?.trim() || 'ffprobe'

const MEDIA_EXTENSIONS = /\.(mp4|mkv|m4a|mp3|webm)$/i

interface StreamKinds {
  hasVideo: boolean
  hasAudio: boolean
}

async function commandExists(
  binary: string,
  versionArgs: readonly string[]
): Promise<boolean> {
  try {
    await execFileAsync(binary, [...versionArgs], { timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

// FFmpeg rejects the GNU `--version` spelling; it wants `-version`, exactly
// like the app's own detector (`probeBinary`).
const ytdlpAvailable = liveNetwork
  ? await commandExists(ytdlpBinary, ['--version'])
  : false
const ffmpegAvailable = liveNetwork
  ? await commandExists('ffmpeg', ['-version'])
  : false

test.describe('live yt-dlp media downloads', () => {
  test.skip(
    !liveNetwork,
    'Live network + yt-dlp acceptance — set MOTRIX_LIVE_NETWORK_TESTS=1'
  )
  test.skip(!ytdlpAvailable, `yt-dlp not found on PATH (${ytdlpBinary})`)
  // The adaptive pair needs FFmpeg to mux; the progressive fallback does not,
  // but keeping the whole suite gated makes the failure mode obvious.
  test.skip(!ffmpegAvailable, 'ffmpeg not found on PATH')

  // A real extraction + transfer + mux needs far more headroom than the
  // hermetic specs.
  test.setTimeout(600_000)

  test('downloads a searched YouTube video as a muxed video file', async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    const videos = await searchYouTube('me at the zoo', 6)
    const harness = await launchMediaApp({
      userDataDir,
      rpcPort,
      ytdlpFormat: 'bv*[height<=360]+ba/b[height<=360]/b',
    })
    try {
      const outcome = await downloadFirstAvailable(harness, videos)
      expect(outcome.task.status).toBe(TaskStatus.Completed)
      expect(outcome.task.kind).toBe(TaskKind.Mux)
      const media = await singleMediaFile(outcome.task)
      expect(media.name).toMatch(/\.(mp4|mkv)$/i)
      const streams = await probeStreams(media.absolutePath)
      expect(streams.hasVideo).toBe(true)
      expect(streams.hasAudio).toBe(true)
      expect(media.bytes).toBeGreaterThan(10_000)
      await harness.mainWindow.screenshot({
        path: testInfo.outputPath('video-download-completed.png'),
      })
      console.log(
        `[media-download] video ${outcome.url} -> ${media.name} (${media.bytes} bytes)`
      )
    } finally {
      await harness.app.close().catch(() => undefined)
    }
  })

  test('downloads a searched Hindi song as an audio-only m4a', async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    const songs = await searchYouTube('hindi song', 8)
    const harness = await launchMediaApp({
      userDataDir,
      rpcPort,
      ytdlpFormat: 'bestaudio[ext=m4a]/bestaudio/b',
    })
    try {
      const outcome = await downloadFirstAvailable(harness, songs)
      expect(outcome.task.status).toBe(TaskStatus.Completed)
      const media = await singleMediaFile(outcome.task)
      expect(media.name).toMatch(/\.(m4a|webm|mp3|mp4)$/i)
      const streams = await probeStreams(media.absolutePath)
      expect(streams.hasAudio).toBe(true)
      expect(streams.hasVideo).toBe(false)
      expect(media.bytes).toBeGreaterThan(10_000)
      await harness.mainWindow.screenshot({
        path: testInfo.outputPath('audio-download-completed.png'),
      })
      console.log(
        `[media-download] audio ${outcome.url} -> ${media.name} (${media.bytes} bytes)`
      )
    } finally {
      await harness.app.close().catch(() => undefined)
    }
  })
})

interface MediaHarness {
  app: ElectronApplication
  mainWindow: Page
  userDataDir: string
}

interface LaunchMediaOptions {
  userDataDir: string
  rpcPort: number
  /** yt-dlp `-f` selector; the desktop quality lever for this app shell. */
  ytdlpFormat: string
}

/**
 * Seed settings BEFORE `launchMotrix` so its own `settings.json` write is a
 * no-op (`flag: 'wx'`). `media` is parsed field-by-field against the schema
 * defaults, so the sparse block is safe.
 */
async function launchMediaApp(
  options: LaunchMediaOptions
): Promise<MediaHarness> {
  await writeFile(
    path.join(options.userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { autofillClipboardLinks: false },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
      media: {
        ytdlpEnabled: true,
        ytdlpBinaryPath: ytdlpBinary,
        ytdlpFormat: options.ytdlpFormat,
        ytdlpAllUrls: false,
      },
    }),
    { encoding: 'utf8', flag: 'wx' }
  )

  const app = await launchMotrix({
    userDataDir: options.userDataDir,
    rpcPort: options.rpcPort,
    extraEnv: { MOTRIX_YT_DLP_PATH: ytdlpBinary },
  })
  const mainWindow = await app.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await waitForEngineReady(mainWindow)
  return { app, mainWindow, userDataDir: options.userDataDir }
}

/**
 * Ask yt-dlp's search extractor for real watch URLs, shortest first so the
 * subsequent full-stream download stays small. Returns `https://…watch?v=…`
 * URLs; the app only resolves http(s) media URLs (its site allowlist rejects
 * `ytsearch:` pseudo-URLs), so the search must happen here.
 */
async function searchYouTube(query: string, limit: number): Promise<string[]> {
  const { stdout } = await execFileAsync(
    ytdlpBinary,
    [
      '--no-warnings',
      '--flat-playlist',
      '--print',
      '%(id)s\t%(duration)s',
      `ytsearch${limit}:${query}`,
    ],
    { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
  )
  const rows = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, duration] = line.split('\t')
      return { id, duration: Number.parseFloat(duration) }
    })
    .filter(
      (row) =>
        Boolean(row.id) && Number.isFinite(row.duration) && row.duration > 3
    )
    .sort((a, b) => a.duration - b.duration)
  expect(rows.length).toBeGreaterThan(0)
  return rows.map((row) => `https://www.youtube.com/watch?v=${row.id}`)
}

interface DownloadOutcome {
  url: string
  task: DownloadTask
}

/**
 * Submit each candidate URL through the real Add-Task window and return the
 * first that reaches Completed. Candidates that fail (removed, region-locked,
 * bot-gated) are cleared before the next attempt.
 */
async function downloadFirstAvailable(
  harness: MediaHarness,
  urls: readonly string[]
): Promise<DownloadOutcome> {
  const failures: string[] = []
  for (const url of urls) {
    await removeAllTasks(harness.mainWindow)
    await submitUrl(harness, url)
    const task = await waitForTerminalTask(harness.mainWindow)
    if (task.status === TaskStatus.Completed) return { url, task }
    failures.push(`${url} -> ${task.status}: ${task.errorMessage ?? 'unknown'}`)
  }
  throw new Error(
    `no candidate completed.\n${failures.map((line) => `  ${line}`).join('\n')}`
  )
}

async function submitUrl(harness: MediaHarness, url: string): Promise<void> {
  await harness.mainWindow.getByRole('button', { name: 'New task' }).click()
  const addTaskPage = await findAddTaskWindow(harness.app)
  await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(url)
  await addTaskPage.getByRole('button', { name: 'Download' }).click()
}

async function listTasks(page: Page): Promise<DownloadTask[]> {
  return (await page.evaluate(async (channel) => {
    const api = (
      window as unknown as {
        motrix?: { invoke: (channel: string) => Promise<unknown> }
      }
    ).motrix
    if (!api) return []
    return (await api.invoke(channel)) as unknown
  }, Queries.ListTasks)) as DownloadTask[]
}

async function removeAllTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, payload?: unknown) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) return
    const tasks = (await api.invoke('query:listTasks')) as Array<{ id: string }>
    if (tasks.length === 0) return
    await api.invoke('command:removeTasks', {
      taskIds: tasks.map((task) => task.id),
      deleteWithFiles: true,
    })
  })
}

async function waitForTerminalTask(page: Page): Promise<DownloadTask> {
  let latest: DownloadTask | undefined
  await expect
    .poll(
      async () => {
        const tasks = await listTasks(page)
        latest = tasks[0]
        if (!latest) return 'pending'
        return [TaskStatus.Completed, TaskStatus.Error].includes(latest.status)
          ? 'terminal'
          : latest.status
      },
      { timeout: 420_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe('terminal')
  return latest as DownloadTask
}

interface MediaFile {
  name: string
  absolutePath: string
  bytes: number
}

async function singleMediaFile(task: DownloadTask): Promise<MediaFile> {
  if (task.finalPath) {
    const fileStat = await stat(task.finalPath).catch(() => null)
    if (fileStat?.isFile()) {
      return {
        name: path.basename(task.finalPath),
        absolutePath: task.finalPath,
        bytes: fileStat.size,
      }
    }
  }
  const entries = await readdir(task.saveDir).catch(() => [] as string[])
  const media = entries.filter((name) => MEDIA_EXTENSIONS.test(name))
  expect(
    media,
    `expected one media file in ${task.saveDir}, saw: ${entries.join(', ')}`
  ).toHaveLength(1)
  const absolutePath = path.join(task.saveDir, media[0])
  const fileStat = await stat(absolutePath)
  return { name: media[0], absolutePath, bytes: fileStat.size }
}

async function probeStreams(file: string): Promise<StreamKinds> {
  const { stdout } = await execFileAsync(
    ffprobeBinary,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      file,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
  )
  const kinds = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    hasVideo: kinds.includes('video'),
    hasAudio: kinds.includes('audio'),
  }
}
