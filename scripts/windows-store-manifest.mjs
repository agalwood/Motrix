import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'

// These checked-in PNGs are scale-200 assets, despite their unqualified names.
// Paths are package-root relative after copying, and repo-root relative before it.
export const WINDOWS_STORE_SCALE_200_ASSETS = Object.freeze(
  [
    ['StoreLogo', 100, 100],
    ['Square44x44Logo', 88, 88],
    ['Square150x150Logo', 300, 300],
    ['Wide310x150Logo', 620, 300],
  ].map(([name, width, height]) =>
    Object.freeze({
      source: `build/appx/${name}.png`,
      destination: `Assets/${name}.scale-200.png`,
      logicalPath: `Assets/${name}.png`,
      width,
      height,
      scale: 200,
    })
  )
)

// This four-image inventory describes the current test layout only.
// Store assets also need the required scales and app-list target-size variants:
// https://learn.microsoft.com/windows/apps/design/iconography/app-icon-construction
export const WINDOWS_STORE_CURRENT_ASSETS_STORE_READY = false

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Render the P2 declaration contract, without reading or creating package files.
 * This does not verify Partner Center identity, payloads, assets, or Windows support.
 * No protocol, startup, or native-host extensions are enabled before their runtime
 * integration is implemented and verified.
 */
export function renderWindowsStoreManifest(rawMetadata) {
  const { metadata } = validateWindowsStoreMetadata(rawMetadata)
  const displayName =
    metadata.profile === 'test' ? 'Motrix Store TEST ONLY' : 'Motrix'
  const description =
    metadata.profile === 'test'
      ? 'Experimental Windows package; not for distribution'
      : 'Motrix download manager'

  // uap10 attributes declare a packaged classic desktop process at medium IL.
  // Do not combine this model with the older EntryPoint declaration.
  // https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-application
  // MinVersion/MaxVersionTested below are configured P2 thresholds, not evidence
  // of testing on Windows 10 22H2 or any other Windows release.
  // https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-targetdevicefamily
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${escapeXml(metadata.identity.name)}" Publisher="${escapeXml(metadata.identity.publisher)}" Version="${escapeXml(metadata.packageVersion)}" ProcessorArchitecture="${escapeXml(metadata.architecture)}" />
  <Properties>
    <DisplayName>${escapeXml(displayName)}</DisplayName>
    <PublisherDisplayName>${escapeXml(metadata.identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>${escapeXml(description)}</Description>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-US" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19045.0" MaxVersionTested="10.0.19045.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="Motrix" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${escapeXml(displayName)}" Description="${escapeXml(description)}" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`
}

/**
 * The MakePri project root must contain Assets/. Keep that root as the resource
 * reference base while limiting traversal to Assets, excluding the app payload.
 * No packaging element means no automatic Language/Scale resource-package split.
 * Store's scale-100 default does not create the missing production asset variants.
 * https://learn.microsoft.com/windows/uwp/app-resources/makepri-exe-configuration
 */
export function renderWindowsStorePriConfig(rawMetadata) {
  const { metadata } = validateWindowsStoreMetadata(rawMetadata)
  const scale = metadata.profile === 'test' ? '200' : '100'
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<resources targetOsVersion="10.0.0" majorVersion="1">
  <index root="\" startIndexAt="Assets">
    <default>
      <qualifier name="Language" value="en-US" />
      <qualifier name="Scale" value="${scale}" />
    </default>
    <indexer-config type="folder" foldernameAsQualifier="true" filenameAsQualifier="true" qualifierDelimiter="." />
  </index>
</resources>
`
}
