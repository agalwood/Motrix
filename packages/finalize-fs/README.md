# Finalize filesystem service

The sidecar performs handle-relative, identity-checked file publication and
removal. Renames never replace an existing destination. Reparse points and
unsafe path components remain rejected on Windows.

## Windows and SMB

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
