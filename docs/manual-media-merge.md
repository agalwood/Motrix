# Manual audio and video merging

This feature requires a Motrix build containing the manual media merge interface
and an enabled media merge plugin. Installing the plugin alone in an older build
does not add the interface.

Configure FFmpeg in **Settings → Integration → Media Tools**, then install the
plugin's `.moext` package from the Plugins page. The plugin requests the `ffmpeg`
permission. If you configure FFmpeg after activating the plugin, disable and
re-enable the plugin to refresh its capability snapshot.

There are two entry points:

1. Select two completed, single-file downloads and choose **Merge audio and video**
   in the task action menu. The window pre-fills their paths.
2. Open the installed media merge plugin's **Operations** tab. Select a local
   video, an audio file, and an output filename directly on the page.

![Media merge Operations tab in the Web UI (Simplified Chinese)](../screenshots/motrix-media-merge-cn-light.png)

The Operations tab and the task-menu dialog share the same form. Switching tabs
keeps the selected files and progress. Returning to the page in the same window
restores your draft and refreshes its recent merge status. After success,
**Merge another file** keeps the inputs and clears the output for a new filename.
These drafts are not saved across application restarts.

In either entry point on desktop, drop one video and one audio file onto their
cards, or click a card to open the existing file picker. Cards emphasize the
filename; hover to see the full path. Choose **MP4** or **MKV** to update the output
extension automatically. Choosing a format before a video also uses that format
for the suggested filename. The format is retained with the draft. Confirm a
save location and new filename, then click **Merge**. Audio-only MP4 files are supported. The supplied plugin
inspects stream types and swaps the inputs when they are unambiguously reversed.
If both files contain both types of tracks, the Video field supplies the first
video track and the Audio field supplies the first audio track.

The plugin copies the encoded tracks without re-encoding them. It does not join
clips end to end, align recordings with different start times, or adjust audio
sync. MP4 cannot carry every codec; try MKV if the MP4 merge fails.

Original files remain in place. Existing output files are never overwritten,
including files created while the merge is running. A temporary directory beside
the destination is removed after success, failure, or cancellation. Publication
uses an atomic, non-replacing hard link; the destination filesystem must support
hard links. A failed publication preserves the original files and reports an
error. Unexpected process termination may leave a `.motrix-merge-*` temporary
directory; remove it only after confirming no merge is running.

Only one manual merge runs per host. The window displays progress and provides
**Cancel**; the operation has a one-hour limit. Jobs are not restored after an app
restart. The merged file is saved to the selected destination, not added as a new
download task.

Both shells use the existing shared path picker. Desktop uses native file dialogs;
the Web UI reuses the server directory browser, including navigation, favorites,
hidden files and sorting. Select the input files, then choose the output folder and
enter a new filename in the save dialog. Existing files cannot be overwritten.
The browser operates on the Motrix server’s files; it does not upload local files.
The server’s configured download-directory policy applies to browsing, input
selection and output. Files are revalidated when selected and when merging.

Open **Logs** from the top-right actions in the plugin detail page to inspect
merge activity. The host records start, cancellation requests, completion,
cancellation, and failure, with a job ID, filenames, output format, and elapsed
time. Failures include the stage and reason, including file validation and final
save failures. Completion is logged only after the output is successfully saved.
Entries also go to the existing plugin log file on both desktop and Server.
File fields show filenames by default; the log page's verbose mode retains full
paths. Progress updates do not generate individual log entries.

## Plugin command contract

A feature introduced during beta must declare an explicit beta minimum in
`engines.motrix`, using the first host version that contains the feature. For
example, `>=2.0.0-beta.45` rejects beta.44, accepts beta.45 and later betas, and
also accepts the final `2.0.0` release. Any range containing a prerelease uses
full SemVer precedence. Release-only ranges retain the existing host API-line
compatibility behavior, so `>=2.0.0 <3.0.0` continues to allow 2.0.0 beta hosts;
use an explicit beta minimum when a plugin needs a newer beta capability.

A plugin opts into this interface by requesting the required `ffmpeg` permission
and declaring a public command named `<plugin-id>.mergeStreams` with both argument
and result schemas. This convention uses the existing manifest schema; it does
not introduce new manifest keywords or a general-purpose command console.

The host passes `{ videoInput, audioInput, output }`, all absolute paths. `output`
is a host-owned temporary path with the user's chosen extension. The command
returns `{ outputPath: output }` only after its FFmpeg operation succeeds.

```ts
commands.register('example.media-merge.mergeStreams', async (args) => {
  const operation = await ffmpeg.mergeStreams(args)
  await operation.result
  return { outputPath: args.output }
})
```

Await the launch call as well as `operation.result`: the current QuickJS bridge
returns the handle asynchronously. The host validates command arguments and
results against the manifest, runs the command in the plugin's FIFO lane, and
holds the job until its processes have stopped. During this invocation, FFmpeg
can probe only the two selected input paths and launch one merge into the reserved
output. Other FFmpeg operations and nested plugin commands are rejected. Input
protocols are restricted to local file processing. Progress and cancellation are
owned by the host; the plugin does not need a polling loop.
