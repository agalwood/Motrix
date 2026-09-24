# Finalize filesystem service

The sidecar performs handle-relative, identity-checked file publication and
removal. Renames never replace an existing destination. Reparse points and
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

## Linux and NFS

Linux NFS mounts can reject `renameat2(RENAME_NOREPLACE)` with `EINVAL` even
when ordinary rename works. For a regular file only, the native rename call
reports `rename_unsupported` for `EINVAL`, `EOPNOTSUPP`, or `ENOSYS`. The host
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

Each file removal first journals a new mode-0700 sibling directory and its
device/inode identity. Ordinary rename is confined to that empty private
directory, then a newly opened, identity-checked handle removes the isolated
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

Public targets are never overwritten. Permissions, target conflicts, I/O and
sync errors remain errors. Directory publication and same-path plugin
replacement still require native no-replace rename; they do not use the file
fallback. Filesystems without hard links or a usable Linux `/proc/self/fd`
retain the journal and return an error. `rustix` supplies the safe Unix syscall
wrappers; `sha2` supplies the shared digest implementation. Neither replaces
the application's durable transaction and recovery rules.

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
