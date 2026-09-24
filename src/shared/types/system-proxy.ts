export interface SystemProxyResult {
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  user?: string
  password?: string
  bypass?: string[]
}
