# Official optional plugins

Official optional plugins are installed from the plugin marketplace. Choose a
plugin, select **Install**, review its permissions, then confirm. Optional
permissions remain off until granted. Installed plugins can be disabled,
updated, or uninstalled from their detail page in both the desktop and server
applications.

Motrix displays **Official Motrix signature verified** only after checking the
complete package against its pinned official signing keys. Marketplace labels
alone do not establish this identity. Package size, SHA-256, manifest identity,
version, engine requirements, and declared permissions must also match the
marketplace entry.

The app retains the signed archive and checks it again during discovery and
before execution. Trusted manifests and executable code are read from that
archive, not the extracted files. An invalid signature prevents loading.

Official optional plugins use the same permission confirmation, optional grants,
and upgrade consent as community plugins. Official signing allows the
`motrix.*` namespace but does not grant built-in-only hook roles such as
`pre-resolve`. Plugins bundled with the app continue to use the separate signed
built-in update channel and cannot be replaced through optional installation.

## Host compatibility

`motrix.media-merge` is an official optional plugin. Its current manifest requires
`>=2.0.0-beta.47 <3.0.0`: beta.46 is rejected; beta.47, later 2.0 betas, and
compatible 2.x releases are accepted; 3.0.0 is rejected. Configure FFmpeg before
installing it and review the required `ffmpeg` permission.

An incompatible marketplace entry remains visible with installation disabled.
Its detail page shows the full required range and the current host version,
with guidance to upgrade or switch to a compatible version. The host checks the
registry requirement before downloading, then independently checks the package
manifest before requesting consent. Package imports also return the requirement
and current version when manifest compatibility fails. Both desktop and server
use the same localized message. No plugin is installed and no grants are saved
on this failure. A range with an upper bound must not be shortened to “version+”.

The screenshots below use local UI fixtures to illustrate the actual components;
they do not indicate that a package has been published to the live marketplace.

![Official optional plugin consent (Simplified Chinese)](../screenshots/motrix-official-plugin-consent-cn-light.png)

![Media merge rejected on beta.46 (Simplified Chinese)](../screenshots/motrix-plugin-version-requirement-cn-light.png)

## Publishing requirements

The registry v2 format is unchanged. An optional official entry supplies a
package URL, size, SHA-256, and an Ed25519 `package.signature` over the exact
`.moext` bytes, using a key trusted by the app. Both existing registry origins
remain supported: identity is established by signature verification. An entry
marked `builtin` must have a valid official signature to enter optional
installation when it is not bundled with the app.

The manifest must support non-bundled execution. In particular, the retired
`motrix.scraper-hook` 1.0.0 package uses `pre-resolve` and remains unavailable for
optional installation. Publish and list the revised `enrich` implementation
before offering it again. Updating the app alone does not publish that package.
Unsigned local files or arbitrary download URLs cannot claim official identity;
this installation channel obtains the detached signature from the registry.

## Security policy support

The security-policy implementation covers bundled, optional official, community,
and manually imported plugins in both Electron and Server. **This change does
not provision a production policy service.** Until independent public keys and
a signed baseline are checked into `src/shared/plugin-security-trust.ts`, the
service is dormant, makes no requests, and provides no remote revocation.
Existing package-signature verification remains in force.

Once provisioned, each host checks a shared static HTTPS feed every 12 hours,
with ±10% jitter. Checks use ETags and are coalesced; the schedule and retry
backoff survive restart. A due startup or desktop-resume check is spread over
5–30 seconds. Failures retry after approximately 15 minutes, one hour, then
three hours, respecting bounded `Retry-After`. Requests have a five-second
deadline and a 256 KiB response limit. No plugin inventory is transmitted and
renderer windows do not poll separately. Server and desktop share the same
core implementation. No network request is made during plugin invocation or
page navigation. Routine failures are logged without repeated dialogs.

Rules match a plugin ID with optional inclusive lower/exclusive upper version
bounds, or an exact `.moext` SHA-256. Version comparisons include prereleases.
Archive hashes are distinct from executable-entry hashes. New installations
retain their archive hash; legacy unpacked plugins and bundled seeds may lack
it, so advisories affecting those installations must also include ID/version
selectors. Development directories still receive ID/version checks. These are
known-threat rules, not malware detection or a safety certification.

Accepted rules are checked before installation consent, again at commit, at
activation, and through the existing execution-policy leases. A new block closes
admission, aborts leases, terminates the guest without running guest cleanup,
and terminalizes its queued post-deliveries with `security_revoked`. Returned
series-hook results are rechecked before engine dispatch and database commit;
in-flight create requests use the existing engine compensation path. Config,
grants, plugin files, and the user's enabled preference are preserved. A cache
verification failure holds execution but does not permanently discard queued
deliveries. Already completed external side effects cannot be undone.

Known blocks persist offline and after signed metadata expires. Other existing
plugins remain usable offline. A new external archive can be installed offline,
but its first activation requires a successful trusted check within 24 hours
and unexpired signed metadata. Its host-owned admission receipt is bound to the
exact archive and survives restart. Builtin overlay updates require fresh
policy before committing. A higher signed revision must explicitly withdraw
an advisory to release its block; omission or narrowing is rejected. Updating
to an unaffected version can also remove the block. Normal activation resumes
according to the unchanged enabled preference; historical dead letters are
not replayed. Clients without this implementation cannot enforce these rules.

### Policy format and publication

`src/shared/schemas/plugin-security.ts` is the authoritative strict contract.
The payload contains `schemaVersion: 1`, a monotonically increasing `revision`,
UTC `issuedAt`/`expiresAt`, and an `advisories` array. Each advisory has a unique
`id`, `status` (`active` or `withdrawn`), `reason` (`malware`, `vulnerability`, or
`compromised`), and one or more `affected` selectors. Selectors are ORed:

```json
[
  { "kind": "plugin", "pluginId": "example.demo", "fromInclusive": "1.0.0", "beforeExclusive": "1.2.0" },
  { "kind": "archive", "sha256": "<64 lowercase hexadecimal characters>" }
]
```

Optional `fixedVersion` and an HTTPS `motrix.app` advisory `url` provide guidance
only. No commands, code, automatic installation, or deletion are allowed. Keep
withdrawn records and their original selectors in subsequent snapshots. If an
affected range was incorrect, withdraw that ID and add a corrected new ID.

The envelope is `{payload, signatures}`. `payload` is canonical base64 of the
exact UTF-8 JSON bytes. Each Ed25519 signature covers the UTF-8 prefix
`motrix-plugin-security-v1\n` followed by those decoded bytes. Any pinned policy
key may verify it; package-signing keys must not be reused. This is a bounded
signed-feed protocol, not an implementation of the full TUF role hierarchy.
Policy lifetime is capped at 14 days; publish renewed signed metadata before
expiration even when advisories are unchanged. HTTP 304 never extends the
signed expiration. Expiry detects stale distribution but cannot deliver a new
block to an offline client. Network rollback protection uses the persisted
revision and the bundled baseline; replacing the client or its trusted local
profile is outside this mechanism's protection.

Prepare an envelope offline using an independently managed Ed25519 private key:

```sh
node --import tsx scripts/sign-plugin-security.mjs \
  --input policy.json --key /secure/policy-signing.pem \
  --previous previous-signed.json --output next-signed.json
pnpm run check:plugin-security -- --require-configured
```

Omit `--previous` only for the initial policy. The signing tool validates the
payload and transitions, verifies its output, and refuses to overwrite an
artifact. It does not generate keys or publish anything. Provision the public
key, an empty signed initial baseline, and the actual HTTPS URL in the build;
run the required configured check before distributing an enabled build. Never
commit private keys or sign test revocations with production keys. Rotate keys
through a host release containing both the old and new public keys before
switching signers; supply `--previous-public-key /trusted/old-public.pem` when
signing with the new key so the preceding envelope is verified with the old key.
Do not silently treat a signature failure as an initial publication.

Publish only reviewed envelopes through a protected deployment workflow to a
CDN-cached static object, with a short edge TTL (for example five minutes), stable
ETags, and an atomic object replacement. Keep versioned artifacts for audit;
undo a mistaken rule with a higher revision and explicit withdrawal, never by
restoring an old object. Under healthy networking a 12-hour client schedule may
take about 13 hours to observe a new block, plus CDN/network delays. A storage
failure preserves in-memory blocks and closes new first admissions, but no
implementation can promise persistence across power loss when disk writes fail.
