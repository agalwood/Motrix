import { readFile } from 'node:fs/promises'
import type { CountryRef } from '@shared/types/geoip'
import { Reader } from 'mmdb-lib'
import type { CountryResponse } from 'mmdb-lib/lib/reader/response'

/**
 * Wraps the on-disk mmdb file behind a simple `lookupCountry(ip)`
 * surface. The class owns one Reader at a time; callers swap to a
 * fresh DB by invoking {@link reload}, which discards the previous
 * Reader before opening the new buffer.
 */
export class GeoIPService {
  private reader: Reader<CountryResponse> | null = null

  /**
   * Try to open the mmdb file at `dbPath`. Returns true on success.
   * Failure cases (missing file, malformed buffer, mmdb-lib structural
   * rejection) all resolve false so callers can render a graceful
   * "database not loaded" state rather than catching exceptions.
   */
  async open(dbPath: string): Promise<boolean> {
    try {
      const buf = await readFile(dbPath)
      this.reader = new Reader<CountryResponse>(buf)
      return true
    } catch {
      this.reader = null
      return false
    }
  }

  /** Close the current reader and open a new one in its place. */
  async reload(dbPath: string): Promise<boolean> {
    this.close()
    return this.open(dbPath)
  }

  /** Drop the in-memory reader; releases the underlying Buffer for GC. */
  close(): void {
    this.reader = null
  }

  isLoaded(): boolean {
    return this.reader !== null
  }

  /**
   * Look up the country for an IPv4/IPv6 address. Returns null when no
   * database is loaded, the address is malformed, or the lookup misses.
   * The English country name is returned as a stable identifier — the
   * renderer overrides it with `Intl.DisplayNames` for the active UI
   * locale, so this value is mostly a fallback.
   */
  lookupCountry(ip: string): CountryRef | null {
    if (!this.reader || !ip) return null
    try {
      const result = this.reader.get(ip)
      const code = result?.country?.iso_code
      if (!code) return null
      const name = result.country?.names?.en ?? code
      return { code, name }
    } catch {
      return null
    }
  }
}
