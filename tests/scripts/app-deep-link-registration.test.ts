import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

describe('app deeplink registration contract', () => {
  it.each(['electron-builder.json', 'electron-builder.signing.json'])(
    '%s advertises motrix and magnet without the retired mo alias',
    (file) => {
      const config = JSON.parse(read(file))
      expect(
        config.protocols
          .flatMap((item: { schemes: string[] }) => item.schemes)
          .sort()
      ).toEqual(['magnet', 'motrix'])
    }
  )

  it.each([
    'flatpak/app.motrix.native.desktop',
    'build/snap/gui/motrix.desktop',
  ])('%s exposes the supported schemes only', (file) => {
    const types = /^MimeType=(.*)$/m.exec(read(file))?.[1].split(';')
    expect(types).toContain('x-scheme-handler/motrix')
    expect(types).toContain('x-scheme-handler/magnet')
    expect(types).not.toContain('x-scheme-handler/mo')
  })

  it('guards Windows mo cleanup with the exact current installation command', () => {
    const installer = read('build/installer.nsh')
    const macro =
      /!macro deleteRetiredMoProtocolHandler ROOT\n([\s\S]*?)!macroend/.exec(
        installer
      )?.[1] ?? ''
    expect(macro).toContain(
      `ReadRegStr $0 \${ROOT} "Software\\Classes\\mo\\shell\\open\\command" ""`
    )
    expect(macro).toContain(
      `\${if} $0 == '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'`
    )
    expect(macro).toContain(`DeleteRegKey \${ROOT} "Software\\Classes\\mo"`)
    expect(macro.indexOf(`\${if}`)).toBeLessThan(macro.indexOf('DeleteRegKey'))
    expect(macro).toContain(`\${endif}`)
    expect(installer).toContain(
      '!insertmacro deleteRetiredMoProtocolHandler HKCU'
    )
    expect(installer).toContain(
      '!insertmacro deleteRetiredMoProtocolHandler SHELL_CONTEXT'
    )
  })
})
