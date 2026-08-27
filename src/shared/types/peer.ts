import type { CountryRef } from './geoip'

/**
 * A single BitTorrent peer connected to a task. Translated from
 * aria2's `aria2.getPeers` response in core/engine/aria2/translate.ts.
 *
 * Country information is injected by the shared task-peers query handler when
 * the GeoIP service is enabled and a database is loaded. The engine adapter
 * never sees this field.
 */
export interface TaskPeer {
  /**
   * Stable React key. Composed as `${ip}:${port}` since aria2 does not
   * expose its internal peer handle and the same swarm peer can be
   * dropped + re-added with a fresh peerId across polls.
   */
  id: string
  ip: string
  port: number
  /**
   * Human-readable client name decoded from the peerId via
   * `bittorrent-peerid`. Null when the engine returned an empty peerId
   * (handshake not yet exchanged) or the bytes did not match any
   * known scheme.
   */
  client: string | null
  /** Version string when the peerId scheme encodes one. */
  clientVersion: string | null
  /** 0..1 fraction of pieces the peer reports having. */
  progress: number
  /** Bytes/sec we are downloading from this peer. */
  downSpeed: number
  /** Bytes/sec we are uploading to this peer. */
  upSpeed: number
  /** Peer announced it has the entire torrent. */
  seeder: boolean
  /** We are choking the peer (refusing to upload). */
  amChoking: boolean
  /** The peer is choking us (refusing to send pieces). */
  peerChoking: boolean
  /**
   * Resolved country, populated by the shared query handler when GeoIP is
   * enabled and the lookup succeeds. Undefined for clients on the
   * pre-Phase-2 contract; null for "GeoIP enabled but lookup missed".
   */
  country?: CountryRef | null
}
