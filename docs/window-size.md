# Main window size

[简体中文](window-size.zh-CN.md)

Motrix normally keeps its main window at least 914 × 672 logical pixels. For
tiling window managers or compact desktop layouts, you can override these limits
in the `app` object of `settings.json` in your Motrix user data directory.

1. Open **Settings → Advanced**. The **Configuration file** section shows the
   active `settings.json` path; click **Open folder** to locate it.
2. Fully quit Motrix, including the tray or menu bar process, before editing.
3. Add or change these two fields inside the existing `app` object, preserving
   the other settings:

   ```json
   {
     "app": {
       "mainWindowMinWidth": 320,
       "mainWindowMinHeight": 240
     }
   }
   ```

4. Save the file and start Motrix again. You can now resize the main window to
   the configured limits; changing the limits does not resize it immediately.

Each value is an integer from 0 to 2147483647. `0` removes Motrix’s minimum for
that dimension, although the operating system or window manager may still impose
its own minimum. Missing or invalid values fall back independently to 914 for
width and 672 for height. Delete these two fields to restore the defaults.

These desktop-only options have no Settings UI. They survive application updates
and changes to other settings. The New Task and onboarding windows retain their
existing sizes. When restoring a saved main window, Motrix respects the currently
configured minimums.

Layouts below the default minimum are not fully adapted: some content may be
clipped or controls crowded. Increase the window size when needed.

If an edit makes the file unreadable as a settings object, Motrix saves the
original file beside it as `settings.json.corrupt-<timestamp>-<id>.bak` before
creating a default configuration. If the backup cannot be created, Motrix stops
recovery without replacing the file. Permission and disk read errors also stop
loading rather than resetting your settings. Invalid individual fields still
fall back independently without resetting the whole file.
