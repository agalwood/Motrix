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
 * Render the Windows package declaration contract without creating package files.
 * This does not verify Partner Center identity, payloads, assets, or Windows support.
 * StartupTask is opt-in; associations declare handlers without choosing defaults.
 * Native-host declarations remain pending.
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
  // uap3 association Parameters pass one quoted URI/file argument to the full-
  // trust executable. Keep substitutions on Protocol/FileTypeAssociation, not
  // on the extension, and do not prepend a UWP EntryPoint or a launcher command.
  // https://learn.microsoft.com/windows/apps/desktop/modernize/desktop-to-uwp-extensions
  // https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-filetypeassociation
  // Document activates once per selected file; Electron forwards each subsequent
  // activation to its single instance. Single would discard additional files.
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 uap10 desktop rescap">
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
      <Extensions>
        <uap3:Extension Category="windows.protocol" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
          <uap3:Protocol Name="motrix" Parameters="&quot;%1&quot;" />
        </uap3:Extension>
        <uap3:Extension Category="windows.protocol" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
          <uap3:Protocol Name="mo" Parameters="&quot;%1&quot;" />
        </uap3:Extension>
        <uap3:Extension Category="windows.protocol" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
          <uap3:Protocol Name="magnet" Parameters="&quot;%1&quot;" />
        </uap3:Extension>
        <uap3:Extension Category="windows.fileTypeAssociation" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
          <uap3:FileTypeAssociation Name="torrent" Parameters="&quot;%1&quot;" MultiSelectModel="Document">
            <uap:SupportedFileTypes>
              <uap:FileType>.torrent</uap:FileType>
            </uap:SupportedFileTypes>
          </uap3:FileTypeAssociation>
        </uap3:Extension>
        <desktop:Extension Category="windows.startupTask" Executable="app\Motrix.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL" uap10:Parameters="--opened-at-login=1">
          <desktop:StartupTask TaskId="MotrixStartup" Enabled="false" DisplayName="${escapeXml(displayName)}" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`
}

/**
 * Index the isolated PRI project root, which contains only Assets/. Starting
 * inside Assets strips that segment from the logical names; indexing the root
 * preserves Files/Assets/* references without traversing the app payload.
 * No packaging element means no automatic Language/Scale resource-package split.
 * Store's scale-100 default does not create the missing production asset variants.
 * https://learn.microsoft.com/windows/uwp/app-resources/makepri-exe-configuration
 */
export function renderWindowsStorePriConfig(rawMetadata) {
  const { metadata } = validateWindowsStoreMetadata(rawMetadata)
  const scale = metadata.profile === 'test' ? '200' : '100'
  return String.raw`<?xml version="1.0" encoding="utf-8"?>
<resources targetOsVersion="10.0.0" majorVersion="1">
  <index root="\" startIndexAt="\">
    <default>
      <qualifier name="Language" value="en-US" />
      <qualifier name="Scale" value="${scale}" />
    </default>
    <indexer-config type="folder" foldernameAsQualifier="true" filenameAsQualifier="true" qualifierDelimiter="." />
  </index>
</resources>
`
}
