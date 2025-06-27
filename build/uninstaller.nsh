# Custom NSIS script for Minecraft Core uninstaller
# Adds option to delete saved app data (instances, settings, etc.)

!include "LogicLib.nsh"

# Custom uninstall function that runs after files are deleted
Function un.onUninstSuccess
  # Show message box asking user if they want to delete app data
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to delete your saved data?$\n$\nThis includes:$\n• Server instances and configurations$\n• App settings (window size, startup options)$\n• Mod categories and preferences$\n• Runtime files and logs$\n$\nChoose 'No' if you plan to reinstall later and want to keep your settings." /SD IDYES IDYES delete_data IDNO keep_data
  
  delete_data:
    DetailPrint "Removing saved app data..."
    
    # Get the app data directory path
    # This matches the path used in app-store.cjs: app.getPath('userData')
    StrCpy $0 "$APPDATA\minecraft-core"
    
    # Check if directory exists before trying to delete
    ${If} ${FileExists} "$0\*.*"
      DetailPrint "Deleting: $0"
      RMDir /r "$0"
      
      # Verify deletion
      ${If} ${FileExists} "$0\*.*"
        DetailPrint "Warning: Some files could not be deleted from $0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Some app data files could not be deleted. You may need to manually remove them from:$\n$\n$0"
      ${Else}
        DetailPrint "App data successfully removed"
        MessageBox MB_OK|MB_ICONINFORMATION "App data has been successfully removed."
      ${EndIf}
    ${Else}
      DetailPrint "No app data found to delete"
    ${EndIf}
    Goto done
  
  keep_data:
    DetailPrint "Keeping saved app data"
    MessageBox MB_OK|MB_ICONINFORMATION "Your app data has been preserved for future installations."
    Goto done
  
  done:
FunctionEnd 