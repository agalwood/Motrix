export function engineBinaryName(platform: string): string {
  return platform === 'win32' ? 'taiji.exe' : 'taiji'
}
