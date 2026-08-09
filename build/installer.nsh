!macro deleteMotrixNativeMessagingKeys
  DeleteRegKey HKCU "SOFTWARE\Google\Chrome\NativeMessagingHosts\app.motrix.bridge"
  DeleteRegKey HKCU "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\app.motrix.bridge"
  DeleteRegKey HKCU "SOFTWARE\Mozilla\NativeMessagingHosts\app.motrix.bridge"
!macroend

!macro customUnInstall
  ; electron-builder also runs the previous uninstaller during an update.
  ; Preserve Native Messaging registration unless this is a real uninstall.
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
