!define MOTRIX_REGISTERED_APP_NAME "Motrix"
!define MOTRIX_CAPABILITIES_KEY "Software\Motrix\Capabilities"
!define MOTRIX_TORRENT_PROGID "Motrix.File.Torrent"
!define MOTRIX_MAGNET_PROGID "Motrix.Url.Magnet"
!define MOTRIX_PROTOCOL "motrix"

!macro deleteLegacyMotrixProtocolHandlers
  ; Electron versions before installer-owned registration wrote URL handlers
  ; into HKCU at runtime. Remove the proprietary scheme unconditionally, then
  ; remove a legacy magnet command only when it names the Motrix executable.
  ; This also prevents an old HKCU handler from shadowing a new all-users
  ; registration during a per-user -> per-machine update.
  DeleteRegKey HKCU "Software\Classes\${MOTRIX_PROTOCOL}"

  ReadRegStr $0 HKCU "Software\Classes\magnet\shell\open\command" ""
  ${StrContains} $1 '\${APP_EXECUTABLE_FILENAME}"' $0
  ${if} $1 != ""
    DeleteRegKey HKCU "Software\Classes\magnet\shell"
  ${endif}
!macroend

!macro registerMotrixDefaultApps
  ; Advertise Motrix in Windows Settings > Apps > Default apps without
  ; changing the protected per-user default choice.
  WriteRegStr SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}" "ApplicationName" "${MOTRIX_REGISTERED_APP_NAME}"
  WriteRegStr SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}" "ApplicationIcon" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}\FileAssociations" ".torrent" "${MOTRIX_TORRENT_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}\UrlAssociations" "magnet" "${MOTRIX_MAGNET_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${MOTRIX_REGISTERED_APP_NAME}" "${MOTRIX_CAPABILITIES_KEY}"

  ; Register application-specific ProgIDs so a Windows user choice always
  ; resolves to Motrix rather than a generic class another client can replace.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}" "" "Torrent File"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}" "Content Type" "application/x-bittorrent"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}\DefaultIcon" "" '"$INSTDIR\resources\torrent.ico",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.torrent" "Content Type" "application/x-bittorrent"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.torrent\OpenWithProgids" "${MOTRIX_TORRENT_PROGID}"

  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}" "" "Magnet URI"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}" "Content Type" "application/x-magnet"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\magnet" "" "URL:Magnet URI"
  WriteRegStr SHELL_CONTEXT "Software\Classes\magnet" "Content Type" "application/x-magnet"
  WriteRegStr SHELL_CONTEXT "Software\Classes\magnet" "URL Protocol" ""

  ; motrix: is proprietary and does not need a Default Apps user choice. Keep
  ; it installer-owned so deep links work without Electron writing HKCU keys.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}" "" "URL:Motrix Protocol"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}\shell\open\command" "" '"$appExe" "%1"'

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro deleteMotrixDefaultApps
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${MOTRIX_REGISTERED_APP_NAME}"
  DeleteRegKey SHELL_CONTEXT "${MOTRIX_CAPABILITIES_KEY}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.torrent\OpenWithProgids" "${MOTRIX_TORRENT_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MOTRIX_TORRENT_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MOTRIX_MAGNET_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MOTRIX_PROTOCOL}"

  ; Generic .torrent/magnet metadata is shared with other clients, so leave it
  ; intact and remove only Motrix-owned registration.
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro deleteMotrixNativeMessagingKeys
  DeleteRegKey HKCU "SOFTWARE\Google\Chrome\NativeMessagingHosts\app.motrix.bridge"
  DeleteRegKey HKCU "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\app.motrix.bridge"
  DeleteRegKey HKCU "SOFTWARE\Mozilla\NativeMessagingHosts\app.motrix.bridge"
!macroend

!macro customInstall
  ; Keep the dedicated torrent icon at a stable installed path. `File`
  ; resolves BUILD_RESOURCES_DIR to build/ for normal installers and to the
  ; staged signing-build-resources/ directory for restricted signing builds.
  ; Re-extracting it on every install also refreshes upgrades before the
  ; association is rewritten and the shell icon cache is notified below.
  File "/oname=$INSTDIR\resources\torrent.ico" "${BUILD_RESOURCES_DIR}\torrent.ico"
  !insertmacro deleteLegacyMotrixProtocolHandlers
  !insertmacro registerMotrixDefaultApps
!macroend

!macro customUnInstall
  ; electron-builder also runs the previous uninstaller during an update.
  ; Always remove the old install scope so a per-user registration cannot
  ; shadow a new per-machine registration. The new installer immediately
  ; rewrites the selected scope after an update.
  !insertmacro deleteMotrixDefaultApps

  ${ifNot} ${isUpdated}
    !insertmacro deleteMotrixNativeMessagingKeys

    ; Remove keys left by a previous 32-bit build as well.
    ${if} ${RunningX64}
      SetRegView 32
      !insertmacro deleteMotrixNativeMessagingKeys
      SetRegView 64
    ${endif}

    ; Remove only generated manifests and preserve all other application data.
    Delete "$APPDATA\Motrix\bridge\manifests\chrome.json"
    Delete "$APPDATA\Motrix\bridge\manifests\edge.json"
    Delete "$APPDATA\Motrix\bridge\manifests\firefox.json"
    RMDir "$APPDATA\Motrix\bridge\manifests"
  ${endif}
!macroend
