# Finalize filesystem service

The sidecar performs handle-relative, identity-checked file publication and
removal. No-replace operations never replace an existing destination. The
separate macOS exFAT compatibility operation replaces a journaled reservation
under the ownership assumptions below. Reparse points and
unsafe path components remain rejected on Windows.

## Filename sanitization

Download names are authored by remote servers, torrent metadata and users, so
the host sanitizes the final path component before it reaches any rename or
copy. The `sanitize_name` sidecar operation exposes the same pure function the
host mirrors in TypeScript; it never touches the filesystem and is idempotent.

The rule set follows Chromium's `net/base/filename_util.cc`, tightened to one
domain shared by every platform instead of per-OS masks, because a file
published on macOS must also survive being copied to a Windows or exFAT volume:

- Replace `< > : " | ? * / \` and C0 controls plus DEL with `_`. `:` covers
  both the NTFS alternate-data-stream separator and the macOS Finder `:`→`/`
  display split; `/` and `\` are replaced rather than rejected so a caller
  cannot smuggle extra directory levels into a final component.
- Strip trailing dots and spaces, which Win32 silently drops when it later
  opens the file.
- Append `_` to the stem of Windows reserved device names (`CON`, `PRN`,
  `AUX`, `NUL`, `COM1-9`, `LPT1-9`, `CONIN$`, `CONOUT$`, including the
  superscript `¹²³` one-digit forms), preserving any extension: `CON.txt`
  becomes `CON_.txt`.
- Clamp the component to 254 UTF-8 bytes — under the strictest of Unix
  `NAME_MAX` and the 255 UTF-16-unit Windows per-component limit — truncating
  the stem on a character boundary while keeping a short extension. The budget
  deliberately stops one byte short of the 255-byte hard limit: publication
  may append a conflict suffix (` (1)` or `.N`) after sanitization, and a
  name clamped to exactly 255 would break `NAME_MAX` the moment that suffix
  lands. Firefox makes the same call — `kDefaultMaxFileNameLength` is 254 for
  the same "clamp now, leave room to grow" reason.
- Fall back to `download` when nothing survives (for example `.`).

Differences from Chromium, recorded deliberately: we sanitize to a single
cross-platform domain rather than per-OS masks (Chromium varies the illegal
character set by platform); we do not perform Unicode normalization (NFC/NFD),
since APFS preserves both forms and normalizing would change identities that
the journal compares byte-wise; we do not transliterate or strip characters
beyond the forbidden set, so non-Latin names survive untouched. Only the final
component is sanitized: directory components are user-created through native
dialogs and are validated, not rewritten, by the platform open path.

## Linux, NFS and mounted NTFS

Linux NFS and NTFS-3G mounts can reject `renameat2(RENAME_NOREPLACE)` with
`EINVAL` even when ordinary rename works. For a regular file only, the native
rename call reports `rename_unsupported` for `EINVAL`, `EOPNOTSUPP`, or `ENOSYS`. The host
then journals a hard-link publication intent before installing the target
name exclusively through the held source descriptor. The source name stays
available until the target is durable and the task database commits. Copy
staging on a different filesystem uses this same publication path.

Recovery accepts two names only when their exact identities match a recorded
link intent and successful publication was durably confirmed. An intent alone
cannot distinguish our link from a competing client's same-inode link. Lost
responses or failed confirmation checkpoints with both names present preserve
both files and quarantine the journal for reconciliation. Confirmed publication
can roll forward or roll back before DB commit; committed publication retries
cleanup.

Each file removal first journals a new sibling directory requested with mode
0700 and its device/inode identity. NTFS mount masks can synthesize 0755 even
when 0700 is requested. Isolation accepts owner read/write/execute with no
group/other write access; read/execute access does not permit changing names.
Both the native isolation operation and host recovery check this condition.
Mounts exposing group/other write access (such as 0777) retain the source and
cleanup journal after publication instead of weakening the removal checks.
Ordinary rename is confined to that empty directory owned by the artifact
owner, then a newly opened, identity-checked handle removes the isolated
file. Every removal, including replay of a pending intent, requires a durable,
identity-verified survivor: the source/rollback before commit, or the final
target after commit. Unix removal also revalidates its held survivor name after
content hashing, immediately before unlink. The separate
`remove_opened_preserving` operation fails closed with older sidecars.
Recovery can restart a failed sidecar before preparing or resuming cleanup.

This assumes the application owns its private namespace; processes running
as the same user can still modify it. POSIX cannot atomically validate one name
and unlink another against unrestricted external writers. A crash before the
removal checkpoint can leave an empty private directory, but cannot remove
source data.

The hard-link fallback never overwrites public targets. Permissions, target conflicts, I/O and
sync errors remain errors. Directory publication and same-path plugin
replacement still require native no-replace rename; they do not use the file
fallback. Filesystems without hard links or a usable Linux `/proc/self/fd`
retain the journal and return an error. `rustix` supplies the safe Unix syscall
wrappers; `sha2` supplies the shared digest implementation. Neither replaces
the application's durable transaction and recovery rules.

## macOS local exFAT

Some FSKit exFAT volumes reject exclusive rename with `ENOTSUP` (45), which
differs from `EOPNOTSUPP` (102) on Darwin, and do not support hard links.
Ordinary download suffix removal can use `reserve_exfat_target` followed by
`rename_opened_reserved`. The original no-replace operation keeps its strict
contract. This compatibility route requires a regular file, the same parent,
an exact `.motrix` suffix removal, a local exFAT mount, and no plugin replacement
or staged metadata. Permission, space, I/O and other errors do not enable it.

The host durably journals a version-3 intent containing a random reservation
token and the volume UUID before creating the final name with
`O_CREAT|O_EXCL|O_NOFOLLOW`. The small, nonempty marker contains the token;
its contents establish ownership across remounts, including a lost creation
response before the reservation identity checkpoint. An existing target is
accepted only if it contains the exact journaled marker. A partial marker or
unrelated file is preserved as a conflict. The sidecar retains the source and
reservation descriptors, rechecks both names and marker contents before
ordinary rename, binds the installed name to the held source, and flushes the
parent before replying. The final name may briefly contain the marker; task
completion waits for the database transaction.

Recovery probes the persisted volume UUID before reading file identities.
Missing or different volumes leave the journal pending for reconnection.
Nonempty files must still match their inode and complete content digest;
only their mount-specific device number may change. Legacy version-2 empty
reservations retain their exact-identity checks because they have no token.

This is an application-owned-name contract, not atomic no-replace: an unrelated
writer can replace the reservation between the final check and `renameat`.
Holding its descriptor does not prevent POSIX unlink/replacement. Shared and
unknown filesystems, directory publication, and plugin replacement do not use
this route. Do not describe it as protection against unrestricted concurrent
external writers.

FSKit may change an empty file's inode during rename. The response reports its
actual installed identity, proven through the held descriptor. Synthetic inode
values use Node BigIntStats' signed 64-bit representation on this wire path.
An unacknowledged changed identity cannot be recovered from an empty digest;
recovery retains the file and quarantines the journal instead of guessing.

Critical journal writes use a synchronous `FULL` transaction and enable
SQLite `fullfsync` on macOS, restoring the connection's previous settings
afterward. Native reservation and macOS root syncs use Rust `File::sync_all`,
which requests `F_FULLFSYNC` with std's fallback when unsupported. `WAL` with
`NORMAL` alone does not make each intent durable against system failure. Database task completion and
the journal commit remain one transaction. Durability depends on the volume
and device honoring their synchronization operations.

Before task restore, recovery validates reservations and installed files but
does not roll a reserved publication back through unsupported exclusive rename.
Task recovery routes unfinished journals through the normal finalizer, which
resumes with the task/effects commit boundary. A reservation created before its
identity checkpoint is not automatically removed. A known installed target
rolls forward; conflicting or unknown identities preserve all surviving files.
Older sidecars cannot execute this operation. Older applications reject the
version-3 intent and may quarantine it without deleting its files.

`finalize-exfat.yml` provisions a disposable macOS exFAT image and exercises the
native reservation contract plus real sidecar/SQLite recovery, including host
`SIGKILL` after marker creation, after rename, and before the terminal database
commit. Remount/offline tests run only when `MOTRIX_FINALIZE_EXFAT_TEST_IMAGE`
identifies the disposable image backing the test root; they never detach a
volume supplied through the root variable alone. To run against
an existing disposable volume, set `MOTRIX_FINALIZE_EXFAT_ROOT` and run:

```sh
cargo test --manifest-path packages/finalize-fs/Cargo.toml --locked -- --ignored --exact platform::unix::reserved::tests::exfat_reservations_preserve_conflicts_and_publish_held_files
pnpm exec vitest run src/core/plugin/finalize/finalize-exfat.integration.test.ts
```

## Windows and SMB

Windows rename retries transient sharing conflicts with exponential backoff,
following surge's `retryRename` precedent: antivirus scanners, search indexers
and handles lingering after `Close()` returns can hold the artifact or target
name for a few milliseconds. Only the `ACCESS_DENIED`, `SHARING_VIOLATION` and
`LOCK_VIOLATION` family retries — five attempts with a 50 ms doubling base
(50/100/200/400 ms). Every other error, and exhaustion of the schedule, is
reported immediately; the journal recovery path is unchanged. Unix needs no
equivalent because its rename does not consult share modes.

Windows volumes are checked when opening the actual roots, before the
application records a new finalize journal. The application flushes file data
before publication. Ordinary file FLUSH failures, access failures, full disks,
and network disconnections remain errors.

Some SMB servers reject directory FLUSH with `ERROR_INVALID_FUNCTION` or
`ERROR_NOT_SUPPORTED`. For those two errors only, the sidecar checks the held
directory's `FileRemoteProtocolInfo`. If it confirms SMB 2 or newer, directory
sync reports `remote_acknowledged`. Namespace durability then depends on the
remote server's acknowledgement and storage policy; it is not a guarantee of
survival after a NAS power loss. The host logs this distinction. Other remote
protocols, local volumes, unknown protocols, and other error codes do not use
this fallback. An offline client cache also cannot qualify as a server
acknowledgement. Copy/removal use the same directory policy. File data flushes
are never converted into directory acknowledgements.

Identity queries prefer the 128-bit `FileIdInfo`. Unsupported information
classes fall back to the volume serial and 64-bit file index obtained through
`GetFileInformationByHandle`, with a distinct identity namespace. Empty IDs
are rejected. Directory enumeration uses `FileFullDirectoryInfo`, then opens
each entry and verifies its identity and reparse attributes; enumeration IDs
are not trusted for object identity.

Name-to-handle identity and absence checks request only metadata access. They
must not try a directory-write open against a held file: SMB can report the
sharing conflict before rejecting the directory type, conflicting with the
held file's intentional denial of write sharing.

Removal prefers extended disposition. If the information class is unsupported,
it uses standard delete-on-close on the verified handle. A removal request
consumes its artifact handle, including on error; the caller must close the
registry slot and reopen an artifact to retry. Absence is checked after the
held handle closes. Other processes can delay deletion by retaining handles;
that remains a recoverable error, never a successful cleanup claim.

Error responses include the operation, OS error code and original NTSTATUS
when available. The formatted message identifies the native call/information
class. Existing protocol consumers can ignore the additive fields.

## Recovery

New I/O failures keep the last journal checkpoint available for retry.
Successful rollback closes the journal only after identity and durability
checks. Startup recovery and an explicit finalize retry use the same rollback
implementation under the task's mutation lease.

Legacy journals quarantined by the old blanket `compensation failed after`
handler are considered only for ordinary direct moves with no replacement,
private target, rollback path or removal intent. Exactly one source/target
name must survive and match the recorded source identity. The surviving file
must be flushed before a compare-and-swap reopens the old journal. Malformed
rows, identity quarantines, conflicting names and changed objects remain
isolated. No user database migration or blanket journal deletion is needed.

## Tests

```sh
cargo test --manifest-path packages/finalize-fs/Cargo.toml --locked --all-targets
```

`.github/workflows/finalize-smb.yml` creates a temporary SMB share on Windows
and exercises both UNC and mapped-drive paths. Its ignored-by-default
`smb_share_supports_held_rename_copy_and_removal` test requires
`MOTRIX_FINALIZE_SMB_ROOT` to point to an existing writable SMB share. It creates
and removes only a unique scratch directory below that root.

The application tests in `finalize-smb-recovery.integration.test.ts` use a real
native sidecar and SQLite journal, injecting unsupported-root and post-rename
sync failures at the adapter boundary. They cover live retry, startup rollback,
legacy quarantine recovery, conflicts and offline shares. They can use
`MOTRIX_FINALIZE_FS_TEST_BIN` to select the target platform's binary.


`.github/workflows/finalize-nfs.yml` provisions real NFSv3 and NFSv4.2 mounts
with root squashing. The ignored native test
`nfs_supports_link_publication_and_private_removal` requires a writable
`MOTRIX_FINALIZE_NFS_ROOT` and rejects non-NFS paths. The Linux application test
`finalize-nfs-recovery.integration.test.ts` uses a real sidecar and a local
SQLite database with artifacts on that mount. It covers same-mount and
cross-device publication, conflicts, lost responses, disconnection during
rollback, and reopening the database/sidecar after cleanup interruptions.
`finalize-adversarial.integration.test.ts` additionally injects a competing
same-inode link, a lost rollback source, a changed survivor at native deletion,
and sidecar termination. It uses the same real mount when configured.
Without the NFS variable it uses a local scratch directory and injects only
the unsupported rename response; all subsequent file operations remain real.

The ignored native test `ntfs_supports_link_publication_and_private_removal`
requires `MOTRIX_FINALIZE_NTFS_ROOT` on a scratch NTFS-3G mount with `umask=022`
and POSIX permissions disabled. It checks the real `EINVAL` rename response,
exclusive hard-link publication, synthesized 0755 isolation permissions, and
removal with a verified surviving target. For example, after mounting a test
image at `/mnt/ntfs-test`:

```sh
MOTRIX_FINALIZE_NTFS_ROOT=/mnt/ntfs-test cargo test \
  --manifest-path packages/finalize-fs/Cargo.toml --locked \
  ntfs_supports_link_publication_and_private_removal -- --ignored
```

The application recovery suite accepts the same `MOTRIX_FINALIZE_NTFS_ROOT`
instead of `MOTRIX_FINALIZE_NFS_ROOT`, keeping SQLite on the local filesystem.
The ordinary native and application tests model mount masks without requiring
NTFS. The Linux recovery suite also covers a lost isolation response followed
by restart with 0755 permissions, and preservation of both hard links when
0777 permissions make cleanup unsafe. Windows uses its existing handle-based
removal and SMB flush policy; these Unix permission checks do not apply there.

## Rename completion and retries

Rename responses add `stage`, `mutation`, and `directory_sync_mode`. On success,
`mutation` is `applied` and both changed parent directories have been synced.
Parents with the same held filesystem identity are synced once. The host skips
its duplicate directory syncs only when the sidecar returns a sync mode; older
sidecars retain the caller-owned fallback. File-content sync and journal
checkpoints remain separate requirements.

Failures before the syscall use `not_attempted`, syscall failures use the
conservative `unknown`, and post-rename verification or sync failures use
`applied`. A lost process response is also `unknown`. These fields are diagnostic:
recovery must still inspect both names and their identities before deciding
what to do. They do not authorize replaying an operation or skipping recovery.
`remote_acknowledged` retains the weaker SMB acknowledgement contract and must
not be described as a completed directory flush.

On Windows, rename-only admission and rename share four possible waits of
50, 100, 200, and 400 milliseconds. Only errors 5, 32, and 33 retry. Error 5
is ambiguous and can be a permanent ACL denial; bounded retries never alter
permissions or relax handle sharing. Exhaustion reports the failing stage,
attempt count for that stage, OS code, and original NTSTATUS. The wait budget
does not bound time spent inside a blocking filesystem call.

Directory case-sensitivity queries fall back only on recognized unsupported
information-class errors. Permission, sharing, transport, and I/O failures are
propagated instead of silently switching to case-insensitive lookup.

## Windows FAT-family directory roots

Directory traversal validates directory type and rejects reparse points without
requiring a file identity. Some volume roots, including exFAT roots, report a
zero legacy file index. Their held handles remain usable for relative opens and
directory flushes. Parent flush deduplication requires two matching, nonzero IDs;
when either ID is empty, both parents are flushed. Real query failures still
propagate. Artifact admission, snapshots and name-to-handle checks continue to
reject empty IDs; zero IDs are never treated as evidence that files are equal.

The Windows workflow creates a disposable exFAT VHD and tests both the volume
root and a nested directory, including target conflicts and successful removal
of the `.motrix` suffix. To run the same native test against a disposable exFAT
volume, set `MOTRIX_FINALIZE_EXFAT_ROOT` to its drive root and run:

```sh
cargo test --manifest-path packages/finalize-fs/Cargo.toml --locked -- --ignored --exact platform::windows::tests::exfat_volume_root_and_nested_directory_support_no_replace_rename
```
