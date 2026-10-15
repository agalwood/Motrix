import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Start the Vite preview first, then run:
// node scripts/check-task-removal-ui.mjs http://127.0.0.1:5174
// Uses the Playwright CLI; no live Motrix backend or downloads are involved.
const baseUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:5174').origin
const outputDir = resolve('output/playwright/issue-2334')
mkdirSync(outputDir, { recursive: true })
const localeSource = readFileSync('src/shared/supportedLocales.ts', 'utf8')
const localeArray = localeSource.match(
  /SUPPORTED_LOCALES = \[([\s\S]*?)\]/
)?.[1]
if (!localeArray) throw new Error('Cannot read supported locales')
const locales = [...localeArray.matchAll(/'([^']+)'/g)].map((match) => match[1])

async function checkRemovalUi(page, baseUrl, outputDir, locales) {
  const results = []
  const urlFor = (dataset, language = 'en-US') =>
    `${baseUrl}/popup-preview.html?data=${dataset}&lang=${language}`
  const settleLayout = () =>
    page.evaluate(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().iterations !== Infinity
          )
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
  const inspectDialog = async (scenario) => {
    const result = await page.getByRole('alertdialog').evaluate((dialog) => {
      const header = dialog.querySelector('[data-slot=alert-dialog-header]')
      const description = dialog.querySelector(
        '[data-slot=alert-dialog-description]'
      )
      const rect = dialog.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      const violations = []
      if (
        rect.left < 3 ||
        rect.right > innerWidth - 3 ||
        rect.top < 3 ||
        rect.bottom > innerHeight - 3
      )
        violations.push(
          'Dialog is outside the viewport or lacks focus-ring clearance'
        )
      if (
        dialog.scrollWidth > dialog.clientWidth + 1 ||
        header.scrollWidth > header.clientWidth + 1
      )
        violations.push('Dialog or description has horizontal overflow')
      for (const text of header.querySelectorAll('h2, p')) {
        const range = document.createRange()
        range.selectNodeContents(text)
        for (const fragment of range.getClientRects()) {
          if (
            fragment.left < headerRect.left - 1 ||
            fragment.right > headerRect.right + 1
          )
            violations.push(
              'Title or filename text is outside the scrolling column'
            )
        }
      }
      for (const control of dialog.querySelectorAll('button, input')) {
        const bounds = control.getBoundingClientRect()
        if (
          bounds.left < rect.left + 3 ||
          bounds.right > rect.right - 3 ||
          bounds.top < rect.top + 3 ||
          bounds.bottom > rect.bottom - 3
        )
          violations.push('A control or its focus ring is clipped')
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2
        )
        if (!hit || !control.contains(hit))
          violations.push('A control is obscured')
      }
      return {
        width: rect.width,
        scrollWidth: dialog.scrollWidth,
        description: description.textContent,
        scrollable: header.scrollHeight > header.clientHeight + 1,
        violations,
      }
    })
    if (result.violations.length)
      throw new Error(`${scenario}: ${result.violations.join('; ')}`)
    results.push({ scenario, ...result })
  }
  const checkScenario = async (
    language,
    width,
    fontSize,
    colorScheme,
    dataset,
    screenshot = false
  ) => {
    const scenario = `${language}-${width}-${fontSize}-${colorScheme}-${dataset}`
    await page.setViewportSize({ width, height: 600 })
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.goto(urlFor(dataset, language))
    const remove = page.locator(
      '[data-task-action=remove][data-task-id=preview-task-0]'
    )
    await remove.click()
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = `${fontSize}px`
    }, fontSize)
    await settleLayout()
    await inspectDialog(scenario)
    if (screenshot)
      await page.screenshot({
        path: `${outputDir}/${scenario}.png`,
        scale: 'css',
      })
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('Tab')
      await settleLayout()
      const contained = await page
        .getByRole('alertdialog')
        .evaluate((dialog) => dialog.contains(document.activeElement))
      if (!contained)
        throw new Error(`${scenario}: keyboard focus escaped the dialog`)
    }
    await page.locator('[data-slot=alert-dialog-cancel]').click()
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
    if (!(await remove.count()))
      throw new Error(`${scenario}: cancel removed the task`)
  }

  const matrixLocales = ['en-US', 'zh-TW', 'de', 'ar']
  for (const language of matrixLocales) {
    for (const width of [320, 400]) {
      for (const fontSize of [16, 32]) {
        for (const colorScheme of ['light', 'dark']) {
          for (const dataset of ['demo', 'worst']) {
            await checkScenario(
              language,
              width,
              fontSize,
              colorScheme,
              dataset,
              true
            )
          }
        }
      }
    }
  }
  for (const language of locales.filter(
    (locale) => !matrixLocales.includes(locale)
  )) {
    await checkScenario(language, 320, 16, 'light', 'worst')
  }

  await page.setViewportSize({ width: 400, height: 600 })
  await page.goto(urlFor('worst'))
  for (let index = 0; index < 8; index++) {
    const view = index === 6 ? 1 : index === 7 ? 2 : 0
    await page
      .getByTestId('compact-section-toolbar')
      .getByRole('tablist')
      .getByRole('tab')
      .nth(view)
      .click()
    const row = page.getByTestId(`task-row-preview-task-${index}`)
    const name = await row.locator('span[title]').first().getAttribute('title')
    await row.locator('[data-task-action=remove]').click()
    await settleLayout()
    await inspectDialog(`filename-${index}`)
    const description = await page
      .locator('[data-slot=alert-dialog-description]')
      .textContent()
    if (!name || !description.includes(name))
      throw new Error(`Filename ${index} was lost or escaped twice`)
    if (await page.locator('[data-slot=alert-dialog-description] b').count())
      throw new Error('Filename was interpreted as HTML')
    await page.locator('[data-slot=alert-dialog-cancel]').click()
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  }

  await page.goto(urlFor('demo'))
  const toggle = page.getByRole('group', { name: 'Preview task data' })
  await toggle.getByRole('button', { name: 'Empty', exact: true }).click()
  await page.getByTestId('task-row-preview-task-0').waitFor({ state: 'hidden' })
  if (await page.locator('[data-task-action=remove]').count())
    throw new Error('Empty dataset still has actions')
  await toggle.getByRole('button', { name: 'One', exact: true }).click()
  await page.getByTestId('task-row-preview-task-0').waitFor()
  await page
    .locator('[data-task-action=remove]')
    .click({ modifiers: ['Shift'] })
  if (!(await page.getByRole('alertdialog').getByRole('checkbox').isChecked()))
    throw new Error('Shift-click lost the file-deletion opt-in')
  await page.locator('[data-slot=alert-dialog-cancel]').click()
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  await page.locator('[data-task-action=remove]').click()
  if (await page.getByRole('alertdialog').getByRole('checkbox').isChecked())
    throw new Error('File-deletion opt-in survived cancellation')
  await page.locator('[data-slot=alert-dialog-action]').click()
  await page.getByTestId('task-row-preview-task-0').waitFor({ state: 'hidden' })
  await toggle.getByRole('button', { name: '1,000 rows', exact: true }).click()
  const last = page.getByTestId('task-row-preview-task-999')
  await last.waitFor({ state: 'attached' })
  if ((await page.locator('[data-testid^=task-row-]').count()) !== 1000)
    throw new Error('The large collection lost tasks')
  await last.locator('[data-task-action=remove]').click()
  await inspectDialog('1000-rows-last-task')
  await page.locator('[data-slot=alert-dialog-cancel]').click()
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  await toggle.getByRole('button', { name: 'Worst case', exact: true }).click()
  await page
    .getByTestId('task-row-preview-task-999')
    .waitFor({ state: 'hidden' })
  if (!page.url().includes('data=worst'))
    throw new Error('Dataset selection did not persist in the URL')

  return {
    passed: results.length,
    keyboardScenarios: 64 + locales.length - matrixLocales.length,
    collectionChecks: ['empty', 'one', '1000'],
    deletionChecks: ['cancel', 'shift-click', 'reset opt-in', 'confirm'],
    results,
  }
}

const session = '-s=task-removal-ui'
execFileSync('playwright-cli', [session, 'open', '--browser', 'chrome'], {
  stdio: 'inherit',
})
const code = `async (page) => { return await (${checkRemovalUi.toString()})(page, ${JSON.stringify(baseUrl)}, ${JSON.stringify(outputDir)}, ${JSON.stringify(locales)}); }`
const output = execFileSync('playwright-cli', [session, 'run-code', code], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
writeFileSync(`${outputDir}/results.txt`, output)
if (output.includes('### Error')) {
  process.stderr.write(output)
  process.exitCode = 1
} else {
  const result = output.match(
    /### Result\n([\s\S]*?)\n### Ran Playwright code/
  )?.[1]
  if (!result) throw new Error('The browser did not return test results')
  const summary = JSON.parse(result)
  writeFileSync(`${outputDir}/results.json`, JSON.stringify(summary, null, 2))
  console.log(
    `${summary.passed} task removal UI checks passed. Results: ${outputDir}/results.json`
  )
}
