import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

export interface InspectedProcess {
  pid: number
  name: string
  executablePath: string | null
  commandLine: string | null
}

function execForOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

export function parseLsofPid(output: string): number | null {
  const match = output.match(/^p(\d+)$/m)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function parseSsPid(output: string): number | null {
  const match = output.match(/pid=(\d+)/)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function parseNetstatPid(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    if (columns[0]?.toUpperCase() !== 'TCP') continue
    if (columns[3]?.toUpperCase() !== 'LISTENING') continue
    const local = columns[1] ?? ''
    if (!local.endsWith(`:${port}`)) continue
    const pid = Number(columns[4])
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return null
}

export class Aria2ProcessInspector {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async inspectListeningPort(port: number): Promise<InspectedProcess | null> {
    const pid = await this.findListeningPid(port)
    if (pid === null) return null

    if (this.platform === 'win32') {
      return this.inspectWindowsProcess(pid)
    }
    if (this.platform === 'linux') {
      return this.inspectLinuxProcess(pid)
    }
    return this.inspectPosixProcess(pid)
  }

  isAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  forceTerminate(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      throw new Error('Refusing to terminate an invalid or current process')
    }
    process.kill(pid, 'SIGKILL')
  }

  private async findListeningPid(port: number): Promise<number | null> {
    if (this.platform === 'win32') {
      try {
        return parseNetstatPid(
          await execForOutput('netstat.exe', ['-ano', '-p', 'tcp']),
          port
        )
      } catch {
        return null
      }
    }

    try {
      return parseLsofPid(
        await execForOutput('lsof', [
          '-nP',
          `-iTCP:${port}`,
          '-sTCP:LISTEN',
          '-Fp',
        ])
      )
    } catch {
      if (this.platform !== 'linux') return null
    }

    try {
      return parseSsPid(
        await execForOutput('ss', ['-ltnp', `sport = :${port}`])
      )
    } catch {
      return null
    }
  }

  private async inspectLinuxProcess(pid: number): Promise<InspectedProcess> {
    const [executablePath, commandLine] = await Promise.all([
      readlink(`/proc/${pid}/exe`).catch(() => null),
      readFile(`/proc/${pid}/cmdline`)
        .then((value) => value.toString().replaceAll('\0', ' ').trim())
        .catch(() => null),
    ])
    return {
      pid,
      name:
        (executablePath ? path.basename(executablePath) : null) ??
        this.commandName(commandLine),
      executablePath,
      commandLine,
    }
  }

  private async inspectPosixProcess(pid: number): Promise<InspectedProcess> {
    const [executablePath, commandLine] = await Promise.all([
      execForOutput('ps', ['-p', String(pid), '-o', 'comm=']).catch(() => null),
      execForOutput('ps', ['-p', String(pid), '-o', 'args=']).catch(() => null),
    ])
    return {
      pid,
      name:
        (executablePath ? path.basename(executablePath) : null) ??
        this.commandName(commandLine),
      executablePath,
      commandLine,
    }
  }

  private async inspectWindowsProcess(pid: number): Promise<InspectedProcess> {
    const script = [
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      'Select-Object Name,ExecutablePath,CommandLine',
      'ConvertTo-Json -Compress',
    ].join(' | ')
    try {
      const output = await execForOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ])
      const parsed = JSON.parse(output) as {
        Name?: string
        ExecutablePath?: string | null
        CommandLine?: string | null
      }
      return {
        pid,
        name: parsed.Name || this.commandName(parsed.CommandLine ?? null),
        executablePath: parsed.ExecutablePath ?? null,
        commandLine: parsed.CommandLine ?? null,
      }
    } catch {
      return {
        pid,
        name: 'unknown',
        executablePath: null,
        commandLine: null,
      }
    }
  }

  private commandName(commandLine: string | null): string {
    if (!commandLine) return 'unknown'
    const first = commandLine.match(/^"([^"]+)"|^(\S+)/)
    const value = first?.[1] ?? first?.[2]
    return value ? path.basename(value) : 'unknown'
  }
}
