declare module '*.css' {
  const content: string
  export default content
}

declare module 'bittorrent-peerid' {
  interface ParsedClient {
    client: string
    version?: string
  }
  function peerid(input: Buffer | string): ParsedClient
  export default peerid
}

interface Window {
  motrix: import('./preload/api').MotrixAPI
}
