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


## Operator runbook: independent signing key

Follow an offline-signing, protected-publication, scheduled-client-read workflow.
Commands target macOS/Linux and run from a Motrix repository root containing this
implementation, using its pinned Node/pnpm environment and installed dependencies.
These are operator instructions; authoring this guide does not generate production
keys, upload a policy, or enable clients.
Execute commands in order. If any command exits nonzero, resolve the error before
continuing to the next step.

**Current state:** Client enforcement and signing tools exist; production public
keys and the baseline are empty. The inspected download Worker source handles
release and registry routes, but not `/security/plugins-v1.json`. This repository
has no security-policy publication workflow. Step 4 requires deployment integration
before launch; uploading an object alone does not establish a working feed.

### 1. Prepare a separate operator directory

Choose a controlled directory outside the repository; this example uses
`$HOME/.motrix-policy`. It contains the private key: use encrypted storage with a
separate encrypted backup. Keep it out of Git, ordinary build artifacts, and plugin
release jobs. Set these environment variables again in each new terminal:

```sh
umask 077
export MOTRIX_POLICY_HOME="$HOME/.motrix-policy"
mkdir -p "$MOTRIX_POLICY_HOME/keys" "$MOTRIX_POLICY_HOME/policies" "$MOTRIX_POLICY_HOME/artifacts"
chmod 700 "$MOTRIX_POLICY_HOME" "$MOTRIX_POLICY_HOME/keys"
node --version
pnpm --version
```

Clients and the download Worker need only public keys/signed files. Never send the
private key to the CDN.

### 2. Generate the first Ed25519 key pair

Run once. Existing files are never overwritten and the private key is not printed:

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const dir = path.join(process.env.MOTRIX_POLICY_HOME, 'keys')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
writeFileSync(path.join(dir, 'policy.private.pem'),
  privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
writeFileSync(path.join(dir, 'policy.public.pem'),
  publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o644 })
console.log('Public key SHA-256:', createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex'))
NODE
```

Record the public-key fingerprint and confirm it with another maintainer through a
trusted channel. `policy.private.pem` is signing-only; `policy.public.pem` may be
public and distributed with the host. The current signer reads unencrypted PKCS#8
PEM and has no passphrase prompt: the operator environment must provide encrypted
storage and unlocking. Never paste private-key material or its base64 encoding into
chat, issues, PRs, or command-line arguments.

### 3. Create and sign the initial empty policy

The initial publication uses revision 1, a 14-day lifetime, and no blocked plugins:

```sh
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const now = Date.now()
const policy = {
  schemaVersion: 1, revision: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 14 * 86400_000).toISOString(),
  advisories: [],
}
writeFileSync(path.join(process.env.MOTRIX_POLICY_HOME, 'policies/rev-1.json'),
  JSON.stringify(policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
NODE
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-1.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy.private.pem" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-1.signed.json"
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-1.signed.json"
```

Independently verify with the public key and inspect the revision, dates, and empty
advisory list:

```sh
node --import tsx --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const publicKey = readFileSync(path.join(process.env.MOTRIX_POLICY_HOME, 'keys/policy.public.pem'), 'utf8')
const policy = verifySecurityPolicy(readFileSync(process.env.MOTRIX_POLICY_CANDIDATE, 'utf8'), [publicKey])
if (Date.parse(policy.expiresAt) <= Date.now()) throw new Error('Policy expired')
console.log(JSON.stringify(policy, null, 2))
NODE
```

This only creates local files. Subsequent updates must supply `--previous`; never
restart publication at revision 1.

### 4. Implement the publication endpoint and protected workflow before launch

Use the following proposed deployment contract. Bucket, binding, and environment
names describe resources to provision, not resources already present.

| Item | Proposed configuration |
| --- | --- |
| Fixed client URL | `https://dl.motrix.app/security/plugins-v1.json` |
| Separate R2 bucket / Worker binding | `motrix-plugin-security` / `PLUGIN_SECURITY` |
| Current object | `plugins-v1.json`, replaced as a complete object |
| Non-overwritable history objects | `history/rev-<revision>.json` |
| Response | `application/json`, stable `ETag`, `Cache-Control: public, max-age=300` |
| Reads | Public `GET`/`HEAD`; matching `If-None-Match` returns `304`; no redirects |
| Publication authority | Separate protected environment, e.g. `plugin-security-feed`, with credentials restricted to that bucket |

Implement exact routing, R2 reads, and edge caching through the download Worker's
maintenance process. Do not expose public writes or change existing download URLs.
Design caching explicitly for Worker-mediated R2 reads and use `httpEtag` for the
quoted response header, as described in the [Cloudflare R2 API documentation](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Cache hits must still handle conditional requests; avoid fetching and parsing the
entire origin policy separately for every client.
See the [Cloudflare Cache API example](https://developers.cloudflare.com/r2/examples/cache-api/)
for Worker caching integration.

The publication workflow must:

1. Accept an immutable signed artifact and its SHA-256; verify using protected
   verifier code and pinned public keys. Hold publication credentials only, not the
   signing key. Inputs must not replace trust keys or execute arbitrary code.
2. Validate format, signature, lifetime, size, and policy transition; reconcile the
   preceding revision with the origin object/publication ledger. Initial creation
   must establish that no previous version exists; a failed download or 404 is not
   authorization to reset revision history.
3. Review IDs, version bounds, hashes, fixed versions, and withdrawals. Serialize
   publication and recheck the origin revision or ETag before writing so a stale
   publisher cannot overwrite a newer policy.
4. Save non-overwritable history first, then replace the fixed object completely.
   Purge that URL's cache or wait for its cache lifetime to expire.
5. Download from the public fixed URL, verify signature/revision/artifact hash, and
   record publisher, reviewer, time, revision, public-key fingerprint, and SHA-256.

The existing application's `app-update-feed` workflow does not publish this policy;
configure separate publication credentials for the new bucket. Once implemented and
reviewed, publish the step 3 artifact through the new protected workflow.

### 5. Verify the public artifact and establish the local current version

Run after publication. Do not add `-L` to hide redirects:

```sh
export MOTRIX_POLICY_URL='https://dl.motrix.app/security/plugins-v1.json'
curl --fail --silent --show-error --compressed --proto '=https' \
  --max-time 10 --max-filesize 262144 \
  --dump-header "$MOTRIX_POLICY_HOME/artifacts/published.headers" \
  --output "$MOTRIX_POLICY_HOME/artifacts/published.signed.json" \
  "$MOTRIX_POLICY_URL" &&
cmp "$MOTRIX_POLICY_CANDIDATE" "$MOTRIX_POLICY_HOME/artifacts/published.signed.json"
```

Inspect `published.headers`: require HTTP 200, the correct content type, and an ETag.
`cmp` must exit 0, proving that the CDN file is byte-identical to the verified
candidate. If it differs, investigate a newer publication or stale cache; do not
overwrite a higher origin revision. Also send `If-None-Match` with the actual ETag
and confirm that an unchanged object returns 304.

After confirming the ledger matches the candidate, save the local current version;
retain all historical `rev-*.signed.json` artifacts:

```sh
cp "$MOTRIX_POLICY_HOME/artifacts/published.signed.json" \
  "$MOTRIX_POLICY_HOME/artifacts/current.signed.json"
```

Before the next operation, reconcile `current.signed.json` with the publication
ledger. With multiple operators, one person's last local file is not authoritative;
retrieve and verify the latest successful artifact from controlled history.

### 6. Provision client public keys and signed baseline

The first command below prints public configuration only. Replace the object value
of `PLUGIN_SECURITY_TRUST` in `src/shared/plugin-security-trust.ts` with its output,
keeping the type declaration and `PLUGIN_SECURITY_SIGNATURE_CONTEXT`. Then run the
second command:

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import path from 'node:path'
const home = process.env.MOTRIX_POLICY_HOME
console.log(JSON.stringify({
  url: process.env.MOTRIX_POLICY_URL,
  publicKeys: [readFileSync(path.join(home, 'keys/policy.public.pem'), 'utf8')],
  baseline: readFileSync(path.join(home, 'artifacts/current.signed.json'), 'utf8'),
}, null, 2))
NODE
pnpm run check:plugin-security -- --require-configured
```

Expect `Plugin security trust verified; baseline revision 1.` with exit code 0.
Distribute trust only through reviewed code and host releases, without runtime
trust overrides. Later host releases must embed the latest reviewed snapshot,
including all retained advisories, not a new empty baseline. If it has expired,
renew and publish through step 8, then refresh the baseline; do not weaken checks.

### 7. Validate and release the host

Run the repository's boundary, lint, type, security-policy/install/host tests and
both production builds, then follow the existing host-release workflow. Ensure the
release job runs `pnpm run check:plugin-security -- --require-configured`: ordinary
builds allow unprovisioned development builds, so build success alone is insufficient.

Exercise test blocks with separate test keys, endpoints, and isolated profiles.
Never issue production-signed practice blocks against real plugins. Production
acceptance should confirm baseline loading, successful synchronization via the
plugin page's Check for updates action, and refreshed state. Older hosts lacking
this implementation must upgrade; updating a plugin cannot add host enforcement.

### 8. Renew every seven days

Fourteen days is the signed file's lifetime; 12 hours is the client polling interval;
24 hours is the successful-check freshness required for a new external archive's
first activation. Renew every seven days even with unchanged rules to leave time
for retries. Operator monitoring should alert when 72 hours remain without renewal.
This guide does not create a scheduled job.

Reconcile the latest successful revision, then derive the next payload while
retaining every active and withdrawn advisory:

```sh
node --import tsx --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const home = process.env.MOTRIX_POLICY_HOME
const publicKey = readFileSync(path.join(home, 'keys/policy.public.pem'), 'utf8')
const previous = verifySecurityPolicy(readFileSync(path.join(home, 'artifacts/current.signed.json'), 'utf8'), [publicKey])
const now = Date.now()
const next = { ...previous, revision: previous.revision + 1,
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 14 * 86400_000).toISOString() }
const file = path.join(home, `policies/rev-${next.revision}.json`)
writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log('Next revision:', next.revision, 'Draft:', file)
NODE
```

Record the printed revision. For a block or withdrawal, edit this draft as described
in steps 9/10; ordinary renewal leaves `advisories` unchanged. Replace the example
`2` below with the revision that was printed:

```sh
export MOTRIX_POLICY_REVISION=2
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-$MOTRIX_POLICY_REVISION.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy.private.pem" \
  --previous "$MOTRIX_POLICY_HOME/artifacts/current.signed.json" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.signed.json"
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.signed.json"
```

Repeat the **verification command** from step 3 using the newly selected candidate,
then publish through step 4 and verify through step
5. Update `current.signed.json` only after successful publication. `EEXIST` means an
artifact already exists: inspect it before retrying; never overwrite published history.

### 9. Block a plugin in an incident

Generate the next payload through step 8 and append an advisory to `advisories`.
This example describes a fictional plugin:

```json
{
  "id": "MTX-2026-001",
  "status": "active",
  "reason": "vulnerability",
  "affected": [
    { "kind": "plugin", "pluginId": "example.demo", "fromInclusive": "1.0.0", "beforeExclusive": "1.2.0" }
  ],
  "fixedVersion": "1.2.0"
}
```

It covers `1.0.0 <= version < 1.2.0`, including SemVer prerelease ordering. Version
1.2.0 does not match this ID/version selector. Include `fixedVersion` only when that
fix is actually available. Use `reason: "malware"` for malicious code or `"compromised"`
for compromised distribution. Omit both version bounds to block every version of an
ID. Optional advisory URLs must be published HTTPS pages on `motrix.app`.

To match a confirmed affected archive, hash the complete `.moext` file:

```sh
node --input-type=module - /path/to/affected.moext <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'))
NODE
```

Add `{ "kind": "archive", "sha256": "<actual 64-character lowercase hex digest>" }`
to `affected`. Selectors are ORed, not ANDed. Legacy unpacked installs may lack the
archive hash, so usually include ID/version rules too. Repacking changes the hash;
this mechanism does not detect unknown malicious variants automatically.

After review, complete signing in step 8 and publication/verification in steps 4/5.
Online clients normally learn the rule on their next check: up to approximately
13.2 hours plus CDN/network delay, not realtime delivery or an absolute deadline.
Users can explicitly Check for updates; refreshing a page alone does not force a
policy fetch. Offline clients cannot receive new rules.

### 10. Withdraw a mistaken block or publish a fix

Generate a higher revision, locate the original advisory, and change only its
`status` to `withdrawn`, preserving its `id` and original `affected` selectors. To
correct a range, withdraw the old ID and add a corrected advisory under a new ID.
Never delete records, edit historical artifacts, serve an older policy, or reset
revision numbering.

A plugin remains blocked if another active advisory matches it. An updated plugin
version outside every active selector can become usable; `fixedVersion` alone is
neither an exemption nor an automatic installation instruction. Configuration and
enable preferences survive withdrawal; normal activation resumes and previously
terminalized deliveries are not replayed.

### 11. Rotate keys during normal operation

1. Reuse the key-generation code from step 2 with output filenames changed to
   `policy-next.private.pem` / `policy-next.public.pem`; retain the old pair.
2. Release a host containing both public keys, keeping the old one in `publicKeys`.
3. Retain dual signatures for supported older hosts: use step 8 to sign the next
   revision with the old key, sign the **same payload** with the new key, and combine:

```sh
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-$MOTRIX_POLICY_REVISION.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy-next.private.pem" \
  --previous "$MOTRIX_POLICY_HOME/artifacts/current.signed.json" \
  --previous-public-key "$MOTRIX_POLICY_HOME/keys/policy.public.pem" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.new-signed.json"
node --import tsx --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const home = process.env.MOTRIX_POLICY_HOME
const rev = process.env.MOTRIX_POLICY_REVISION
const read = (file) => readFileSync(path.join(home, file), 'utf8')
const oldEnvelope = JSON.parse(read(`artifacts/rev-${rev}.signed.json`))
const newEnvelope = JSON.parse(read(`artifacts/rev-${rev}.new-signed.json`))
if (oldEnvelope.payload !== newEnvelope.payload) throw new Error('Payloads differ')
const dual = JSON.stringify({ payload: oldEnvelope.payload,
  signatures: [...oldEnvelope.signatures, ...newEnvelope.signatures] }) + '\n'
for (const name of ['policy', 'policy-next']) {
  verifySecurityPolicy(dual, [read(`keys/${name}.public.pem`)])
}
writeFileSync(path.join(home, `artifacts/rev-${rev}.dual-signed.json`), dual,
  { flag: 'wx', mode: 0o600 })
console.log('Dual signature verified with each key independently')
NODE
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.dual-signed.json"
```

4. Publish the `.dual-signed.json` candidate and verify through step 5. Keep dual
   signing every renewal/change during the compatibility period. A client trusting
   only the old key cannot verify a policy signed solely by the new key.
5. After the older-host support period ends, review the switch to new-key-only
   signing. Update local signing/verification paths, the publication workflow, and
   host key sets, and archive the old private key. Do not drop the old signature
   before the new host is sufficiently deployed.

A leaked private key is a different incident: an attacker may sign higher revisions.
Suspend affected signing/publication credentials and distribute a trusted host
update removing the compromised key and supplying a reviewed new baseline. This
protocol cannot revoke embedded trust keys online; dual signing does not restore
security for old hosts that only trust a compromised key.

### 12. Troubleshooting and evidence

| Symptom | Action |
| --- | --- |
| `not provisioned` / required check exits 1 | Complete step 6; a successful dormant build is not an enabled build |
| HTTPS 404 or redirect | Check Worker route, object name, and publication ledger; do not reset revision history |
| `Untrusted security policy signature` | Check fingerprints, signing purpose, rotation stage, and original bytes; keep verification enabled |
| `rollback` / `revision reused` | Use the latest successful predecessor and a new revision |
| `removed or narrowed without withdrawal` | Retain records/selectors and use `withdrawn` |
| `expired` | Retain advisories, advance revision/dates, and re-sign; 304 cannot renew a signature |
| New plugin waits for internet while existing ones work | Check 24-hour successful-check freshness and signed expiry |
| Corrupt cache or unwritable disk | Inspect `plugin:security` host logs and disk, then restore trusted synchronization; do not delete cache to bypass blocks |
| Publication succeeds but client remains stale | Check ETag, caching, host version, 12-hour scheduling, and network backoff |

Retain payload/envelope, revision, lifetime, public-key fingerprint, artifact SHA-256,
predecessor, review record, workflow result, and public verification result for every
publication. Keep keys in key custody, not in the repository alongside this evidence.
