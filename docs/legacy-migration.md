# Migrating legacy Motrix downloads

The desktop Migration Assistant imports selected Motrix v1 records paused.
Keep a backup of the old profile and downloads, close the old application, and
review the selected tasks before importing. Importing records never starts a
transfer or changes the original files.

## Resuming BitTorrent downloads

Supply the original torrent metadata when requested, confirm the original
download directory, and explicitly activate the task. Motrix preserves the
original file selection. The engine imports the `.aria2` checkpoint, creates a
paused task with a durable authorized metadata backup, and verifies its binding
before requesting resume. Existing pieces are checked before transfer.

This requires the running engine to advertise `SQLite3-Persistence`,
`LegacyCheckpointImportV1`, and `LegacyTorrentMetadataV1`. A custom or older
engine without these capabilities cannot activate imported progress. Motrix does
not fall back to a torrent upload that would lose the authorized metadata on
restart.

## Windows destinations

Windows progress import requires a local fixed NTFS volume. Payloads and the
metadata backup must be owned by the account running Motrix, with no write grant
to other users apart from SYSTEM and Administrators. Motrix does not rewrite the
permissions of your downloads. Close other programs writing to these files
before activation.

Unicode names and long paths are supported. Network shares, FAT/exFAT volumes,
junctions, symbolic links, cloud reparse points, hard-linked files, alternate data
streams and aliased paths are refused. Use the original canonical directory;
relocating files or changing their identity requires a separate download.

## HTTP and recovery

Imported HTTP records download into a separate directory when explicitly
activated. A historical checkpoint alone does not prove the remote object is
unchanged, so the assistant does not reuse historical HTTP bytes in place.

After a restart, authorized legacy BitTorrent tasks return paused. Check their
state and explicitly resume. A replaced or modified payload or metadata backup
invalidates recovery; putting an old file back does not revive an invalidated
grant. If an activation response is lost, Motrix reconciles its saved token and
GID instead of blindly creating a duplicate task.

Retain the engine's `*.pre-schema5-*.db` backup when upgrading an old database.
It contains the state before the schema upgrade. An older engine cannot open the
newer schema; stop all engines and restore a verified backup to a separate path
if a downgrade is necessary. Existing released engines and application packages
are immutable; support depends on the engine bundled with the installed build.
