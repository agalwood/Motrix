import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'

const COMPOSE_CWD = 'tests/docker'

export async function composeUp(): Promise<void> {
  await run('docker', ['compose', 'up', '-d'])
  await wait(2000) // allow services to become ready
}

export async function composeDown(): Promise<void> {
  await run('docker', ['compose', 'down', '--volumes', '-t', '2'])
}

export async function isMatrixUp(): Promise<boolean> {
  try {
    const out = await runOutput('docker', ['compose', 'ps', '--format', 'json'])
    return out.includes('"State":"running"')
  } catch {
    return false
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: COMPOSE_CWD, stdio: 'inherit' })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    )
  })
}

function runOutput(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: COMPOSE_CWD })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}`))
    )
  })
}

// Availability detection — tests call this in beforeAll and skip if false.
let cached: boolean | null = null
export async function dockerMatrixAvailable(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    await runOutput('docker', ['version', '--format', '{{.Server.Version}}'])
    cached = true
  } catch {
    cached = false
  }
  return cached
}
