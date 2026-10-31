export {
  BDictionary,
  type BencodeLimits,
  type BInput,
  type BValue,
  DEFAULT_LIMITS,
  type DecodeOptions,
  decode,
  encode,
  TorrentError,
} from './bencode.js'
export {
  encodeMagnet,
  type FileSelection,
  type Magnet,
  normalizeBtih,
  parseMagnet,
} from './magnet.js'
export {
  HashTable,
  parseTorrent,
  type TorrentFile,
  type TorrentIdentity,
  type TorrentMetadata,
} from './metadata.js'
