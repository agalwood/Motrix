# Third-Party Notices

Motrix is distributed under the MIT license (see `package.json` /
`LICENSE`). The source code written for this project is MIT-licensed in full.

However, **this repository also contains third-party assets that are NOT
covered by the MIT license**. Those assets are used under their own terms and
are listed below. If you fork, redistribute, or re-package this project, you
are responsible for ensuring you hold a compatible license for every asset
listed here — or for replacing them with assets you are licensed to
distribute.

---

## Settings page icons (Iconly Pro — UI8)

- **Author / Designer:** Iconly Pro
- **Source:** UI8 marketplace — <https://ui8.net>
- **License:** Proprietary. Licensed per the UI8 Standard License
  (<https://ui8.net/licensing>). **Not MIT.** Not covered by the project's
  LICENSE / `package.json` license field.
- **Usage in this project:** Used as settings navigation icons, rendered by
  `src/renderer/routes/settings/cards` and related components.

### Affected files

```
src/renderer/routes/settings/icons/icon-about@1x.png
src/renderer/routes/settings/icons/icon-about@2x.png
src/renderer/routes/settings/icons/icon-advanced@1x.png
src/renderer/routes/settings/icons/icon-advanced@2x.png
src/renderer/routes/settings/icons/icon-appearance@1x.png
src/renderer/routes/settings/icons/icon-appearance@2x.png
src/renderer/routes/settings/icons/icon-bittorrent@1x.png
src/renderer/routes/settings/icons/icon-bittorrent@2x.png
src/renderer/routes/settings/icons/icon-download@1x.png
src/renderer/routes/settings/icons/icon-download@2x.png
src/renderer/routes/settings/icons/icon-general@1x.png
src/renderer/routes/settings/icons/icon-general@2x.png
src/renderer/routes/settings/icons/icon-integration@1x.png
src/renderer/routes/settings/icons/icon-integration@2x.png
src/renderer/routes/settings/icons/icon-network@1x.png
src/renderer/routes/settings/icons/icon-network@2x.png
```

### What this means for downstream users

- The MIT license on the Motrix source code **does not** grant you the
  right to redistribute these PNG files.
- If you build and ship a derivative (a fork, a private build, a
  repackaging), you must either:
  1. Hold your own valid UI8 / Iconly Pro license that covers the
     redistribution, **or**
  2. Replace these files with icons you are licensed to distribute (for
     example, a set under an SPDX-compatible open-source license such as
     `CC-BY-4.0` or `Apache-2.0`).
- Embedding them inside an Electron `asar` bundle still counts as
  redistribution.

---

## Apple San Francisco tray font (macOS)

- **File:** `extra/tray/SFNS-Regular.ttf`
- **Owner:** Apple Inc.
- **License:** Apple San Francisco Font License. Proprietary; **not MIT**.
- **Usage in this project:** Embedded in the macOS application and loaded by
  the tray speedometer renderer so that its compact text layout remains
  consistent.
- **Official terms:** <https://developer.apple.com/fonts/>

This file is kept because it is part of the macOS tray rendering path. Its
presence in this repository and in a packaged application does not grant
downstream users any rights beyond Apple's terms. Anyone redistributing Motrix
or a derivative must independently verify that their Apple agreement or other
written authorization covers the intended distribution. If it does not, they
must obtain permission or replace the font before distributing the build.

---

## aria2 download engine

Desktop builds bundle an `aria2c` executable pinned by
`scripts/engine.lock.json`:

- **Version:** 1.37.0-motrix.11
- **Source:** <https://github.com/motrixapp/aria2/tree/v1.37.0-motrix.11>
- **License:** GNU General Public License v2.0 or later (`GPL-2.0-or-later`)
- **Full license text:** `THIRD_PARTY_LICENSES/aria2-COPYING`
- **OpenSSL exception / notice:**
  `THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL`

The source link above identifies the source release corresponding to the
bundled binaries. Redistributors must continue to meet the GPL source-code and
notice obligations for the exact binaries they ship, including any additional
libraries linked into their own builds.

---

## GeoIP database (opt-in, downloaded by the user)

Motrix Turbo includes an optional IP-to-country lookup feature that depends on
the **MaxMind GeoLite2-Country** database. This repository does **not**
redistribute any GeoLite2 data file. When the user enables the feature in
Settings → Advanced, the application downloads `GeoLite2-Country.mmdb` from a
source the user has selected and stores it under the user data directory.

The database is licensed by MaxMind and the user agrees to those terms when
enabling the feature:

- [GeoLite2 End User License Agreement](https://www.maxmind.com/en/geolite2/eula)
- [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/)

This product includes GeoLite2 data created by MaxMind, available from
<https://www.maxmind.com>.

Default community mirrors that the user can choose:

- **Loyalsoldier/geoip** (<https://github.com/Loyalsoldier/geoip>) — community
  edition with optional CN-region enhancements; same upstream MaxMind data.
- **P3TERX/GeoLite.mmdb** (<https://github.com/P3TERX/GeoLite.mmdb>) — weekly
  automated mirror of the upstream MaxMind release.

Selecting either mirror means accepting that mirror's terms in addition to
MaxMind's own license. Motrix's MIT license does not extend to the database
contents — those remain governed by MaxMind / CC BY-SA 4.0.

---

## Bundled Motrix extensions

The following signed extension bundles are fetched from pinned releases of
<https://github.com/motrixapp/builtin-plugins> and distributed with the
application:

- `motrix.filename-template`
- `motrix.scraper-hook`
- `motrix.url-resolver`

They are maintained and released by the Motrix project, rather than consumed
as third-party npm dependencies. Their current upstream bundles do not contain
a standalone license declaration, so the generated SBOM records their license
as `NOASSERTION` instead of assuming that this repository's MIT license applies
to a separate repository. Downstream redistributors should not assume they
have redistribution rights until the upstream project publishes applicable
terms. Adding license metadata and notices to the producing repository remains
an upstream release requirement.

---

## npm runtime dependencies and SBOM

The npm dependency inventory is generated from the root runtime dependency
declarations and the installed dependency graph resolved by `pnpm-lock.yaml`.
The generator reads each resolved package's `package.json` and only its
package-root `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, or `COPYRIGHT` files.
Packages that do not publish a top-level license file must have an explicit,
reviewed entry in `scripts/third-party-notices.config.json`.

Every application build generates and distributes these files under `legal/`:

- `THIRD_PARTY_DEPENDENCIES.md` — package, version, source, and SPDX license
  inventory;
- `THIRD_PARTY_LICENSES.txt` — deduplicated full license and notice texts;
- `sbom.spdx.json` — SPDX 2.3 software bill of materials.

Run `pnpm run check:third-party-notices` to validate the declarations and
`pnpm run build:legal` to regenerate the distributable files. The generated
files are platform-specific build output and are not committed.

---

## Rust native messaging executable dependencies

The `motrix-native-host`, host-side `motrix-flatpak-native-host`, and
in-sandbox `motrix-native-host-broker` executables are built from the following
crates locked in `packages/native-host/Cargo.lock`. Windows-only crates are
listed because they are included in the Windows native-host build.

| Crate | Version | SPDX license expression | Repository |
| --- | --- | --- | --- |
| base64 | 0.22.1 | `MIT OR Apache-2.0` | <https://github.com/marshallpierce/rust-base64> |
| block-buffer | 0.10.4 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/utils> |
| cfg-if | 1.0.4 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/cfg-if> |
| cpufeatures | 0.2.17 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/utils> |
| crypto-common | 0.1.7 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/traits> |
| digest | 0.10.7 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/traits> |
| generic-array | 0.14.7 | `MIT` | <https://github.com/fizyk20/generic-array> |
| hkdf | 0.12.4 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/KDFs> |
| hmac | 0.12.1 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/MACs> |
| home | 0.5.12 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/cargo> |
| humantime | 2.4.0 | `MIT OR Apache-2.0` | <https://github.com/chronotope/humantime> |
| itoa | 1.0.18 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/itoa> |
| libc | 0.2.189 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/libc> |
| memchr | 2.8.3 | `Unlicense OR MIT` | <https://github.com/BurntSushi/memchr> |
| proc-macro2 | 1.0.107 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/proc-macro2> |
| quote | 1.0.47 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/quote> |
| serde | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_core | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_derive | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_json | 1.0.151 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/json> |
| sha2 | 0.10.9 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/hashes> |
| subtle | 2.6.1 | `BSD-3-Clause` | <https://github.com/dalek-cryptography/subtle> |
| syn | 3.0.3 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/syn> |
| typenum | 1.20.1 | `MIT OR Apache-2.0` | <https://github.com/paholg/typenum> |
| unicode-ident | 1.0.24 | `(MIT OR Apache-2.0) AND Unicode-3.0` | <https://github.com/dtolnay/unicode-ident> |
| version_check | 0.9.5 | `MIT/Apache-2.0` | <https://github.com/SergioBenitez/version_check> |
| windows-link | 0.2.1 | `MIT OR Apache-2.0` | <https://github.com/microsoft/windows-rs> |
| windows-sys | 0.61.2 | `MIT OR Apache-2.0` | <https://github.com/microsoft/windows-rs> |
| zmij | 1.0.23 | `MIT` | <https://github.com/dtolnay/zmij> |

Each license file below is copied byte-for-byte from a locked crate source.
Common texts are reused only where the license terms are the same;
crate-specific notices are preserved separately:

- `THIRD_PARTY_LICENSES/rust-base64-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-base64-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-block-buffer-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-block-buffer-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-cfg-if-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-common-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-common-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-cpufeatures-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-crypto-common-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-digest-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-generic-array-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-hkdf-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-hkdf-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-humantime-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-libc-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-memchr-COPYING`
- `THIRD_PARTY_LICENSES/rust-memchr-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-memchr-UNLICENSE`
- `THIRD_PARTY_LICENSES/rust-sha2-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-subtle-LICENSE`
- `THIRD_PARTY_LICENSES/rust-typenum-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-typenum-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-unicode-ident-LICENSE-UNICODE`
- `THIRD_PARTY_LICENSES/rust-version_check-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-windows-rs-LICENSE-MIT`

---

## How to report a missing attribution

If you believe a third-party asset is present in this repository but is not
listed above, please open an issue or a pull request updating this file.
