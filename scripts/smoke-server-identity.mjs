const DEFAULT_SMOKE_UID = 1000
const DEFAULT_SMOKE_GID = 1000

export function resolveSmokeContainerIdentity(
  hostUid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  hostGid = typeof process.getgid === 'function' ? process.getgid() : undefined
) {
  const uid =
    Number.isSafeInteger(hostUid) && hostUid > 0 ? hostUid : DEFAULT_SMOKE_UID
  const gid =
    Number.isSafeInteger(hostGid) && hostGid > 0 ? hostGid : DEFAULT_SMOKE_GID
  return { uid, gid, user: `${uid}:${gid}` }
}
