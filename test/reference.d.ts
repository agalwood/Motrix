/** Test-only differential oracle; never imported by production code. */
declare module 'parse-torrent' {
  export default function parseTorrent(input: string | Uint8Array): Promise<{
    infoHash: string
    name?: string
    announce: string[]
    length?: number
    files?: { name: string; path: string; length: number; offset: number }[]
    pieces?: string[]
    private?: boolean
    urlList?: string[]
  }>
}
