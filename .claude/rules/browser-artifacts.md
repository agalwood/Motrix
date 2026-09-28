---
description: Shared output locations for browser tests and ad hoc UI verification
---

# Browser Artifacts

Run browser commands from the repository root. All generated Playwright and
browser-verification artifacts belong under `output/playwright/`:

| Artifact | Location |
|---|---|
| Automated test results, screenshots, traces, and videos | `output/playwright/test-results/<suite>/` |
| HTML reports | `output/playwright/reports/<suite>/` |
| Playwright CLI automatic snapshots and logs | `output/playwright/cli/` |
| Ad hoc screenshots, scripts, preview harnesses, and review notes | `output/playwright/manual/<task-slug>/` |
| Retained release-soak evidence, including JSON reports | `output/playwright/soak/<suite>/<run-id>/` |

## Tool Configuration

- Playwright Test suites set an explicit `outputDir`. Each suite owns a
  separate directory because the runner cleans it before a run. Never point
  a test runner at the shared `output/playwright/` root.
- In tests, use `testInfo.outputPath(name)` or `test.info().outputPath(name)`
  for generated files. Do not hardcode artifact paths in test bodies.
- Reporters set explicit output paths. Open the Electron HTML report with
  `pnpm exec playwright show-report output/playwright/reports/electron`.
- Playwright CLI automatically loads `.playwright/cli.config.json` from the
  repository root. Keep its default `outputDir` aligned with the table above.
  Use a task-specific session name; explicitly named screenshots and other
  captures go in `output/playwright/manual/<task-slug>/`.
- For browser tools that do not read this config, pass the output path
  explicitly. Place custom configs and temporary preview files in the same
  task directory, with their outputs also inside `output/playwright/`.
- Preserve explicit user or CI evidence-directory overrides and existing
  restrictions on capturing pairing passwords or other secrets.

## Repository Hygiene

Do not create new browser-artifact directories at the repository root or
under `e2e/`, `tests/`, `docs/`, `screenshots/`, or `outputs/`. The tracked
`screenshots/` directory contains intentional product assets; `e2e/` and
`tests/e2e/` contain test source and fixtures.

Generated output stays ignored. Legacy ignored directories are not new output
targets. Do not delete or move another task's evidence or active session
files. Close only the browser sessions and preview servers you started.
