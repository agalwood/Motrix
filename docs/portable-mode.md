# Windows portable mode

Download and extract the Windows ZIP, then create a `data` directory beside
`Motrix.exe` before launching it:

```text
Motrix/
  Motrix.exe
  resources/
  data/
    portable.json
    relocations/
    user-data/
    work/
    tmp/
  Downloads/
```

Motrix creates the contents of `data` on startup. `Downloads` is the default
download destination; it is created when needed. The About dialog identifies
portable mode. Settings provides an action to open the active settings file.

The Windows installer and Microsoft Store packages retain their existing
behavior. A directory containing `Uninstall Motrix.exe` is treated as an
installed copy, even when a `data` directory exists. Other platforms and
development builds do not automatically enable this mode.

## Data and system integration

`data/user-data` contains settings, task history, engine state, installed
plugins, plugin credentials, Chromium session storage, logs, and crash dumps.
Task working files, including magnet metadata, live under `data/work`.
Electron, Node, and child-process temporary files use `data/tmp`.

Portable mode does not register or remove startup entries, file associations,
or browser Native Messaging hosts. Automatic CLI installation is unavailable.
The local bridge can still run, but browser launching/discovery through a
system-registered native host is not installed for the portable copy.
Existing installed-copy integrations are left untouched.

The portable profile is independent of an installed profile. Motrix does not
automatically import the host computer's settings or legacy data. Combining
portable mode with `MOTRIX_USER_DATA` or `MOTRIX_BRIDGE_DATA_DIR` is rejected.
An unreadable or unwritable `data` directory stops startup instead of falling
back to AppData.

## Moving the application

Fully exit Motrix before copying the application folder or disconnecting a
drive. Copy the whole folder, including `data`, `Downloads`, and any other
download directories stored within it. Preserve `data/portable.json`: it is
the journal used to recognize the previous location and recover an
interrupted relocation. Original settings and path records are retained in
`data/relocations` before a move is applied. A retry uses those originals;
manual edits made during an interrupted move stop recovery instead of being
overwritten.

On startup, paths inside the previous application folder are rebased to the
current folder. Settings, task paths, file lists, and nested recovery records
are updated before the engine starts. URLs and paths outside the application
folder are not rewritten. Custom plugin settings, advanced engine configuration, and command scripts remain user-managed. Engine snapshots from an earlier location are not
replayed; task reconstruction uses the relocated Motrix records and the
existing recovery checks. Downloads still require their actual partial files,
checkpoints, and torrent metadata.

After relocation, unfinished tasks targeting external directories stop with
a location error. They are not silently redirected to another drive. Check
their original files and destination before retrying or recreating the task.
Interrupted transition records are preserved, with automatic finalization and
magnet cleanup held until explicit recovery.
Interrupted plugin finalization journals are retained in quarantine for
explicit recovery, since filesystem identity may have changed. Moving a
profile does not add restart/resume support to media pipelines that already
require the task to be added again after interruption.

Do not delete the entire Chromium session directory as a cache: it also
contains persistent browser storage. Plugin credentials travel with the
profile; protect the portable folder as you would your installed profile.

## Updating

Portable mode can check for updates, but it never downloads or runs the
Windows installer. Download the new Windows ZIP, fully exit Motrix, and copy
the complete `data` folder and portable download directories into the new
extracted folder. Keep a backup until the new version starts successfully.
Replacing program files must not replace or discard `data`.
