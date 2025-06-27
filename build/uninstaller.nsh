# Custom NSIS script for Minecraft Core uninstaller
# Adds option to delete saved app data (instances, settings, etc.)

!include "MUI2.nsh"
!include "LogicLib.nsh"

# Variables for uninstall options
Var DeleteAppData
Var DeleteAppDataCheckbox

# Custom uninstaller page for app data deletion
Page custom un.DataDeletionPage un.DataDeletionPageLeave

# Function to create the app data deletion page
Function un.DataDeletionPage
  !insertmacro MUI_HEADER_TEXT "Uninstall Options" "Choose what to remove during uninstallation"
  
  nsDialogs::Create 1018
  Pop $0
  
  ${If} $0 == error
    Abort
  ${EndIf}
  
  # Create label explaining the option
  ${NSD_CreateLabel} 0 0 100% 30u "Minecraft Core stores your server instances, settings, and other data in your user profile. You can choose to keep or remove this data:"
  Pop $0
  
  # Create checkbox for deleting app data (checked by default)
  ${NSD_CreateCheckbox} 0 35u 100% 15u "Delete saved data (instances, settings, configurations)"
  Pop $DeleteAppDataCheckbox
  ${NSD_Check} $DeleteAppDataCheckbox  # Check by default
  
  # Create description of what will be deleted
  ${NSD_CreateLabel} 0 55u 100% 40u "This includes:$\n• Server instances and configurations$\n• App settings (window size, startup options)$\n• Mod categories and preferences$\n• Runtime files and logs"
  Pop $0
  
  nsDialogs::Show
FunctionEnd

# Function called when leaving the app data deletion page
Function un.DataDeletionPageLeave
  ${NSD_GetState} $DeleteAppDataCheckbox $DeleteAppData
FunctionEnd

# Custom uninstall function
Function un.onUninstSuccess
  # Check if user wants to delete app data
  ${If} $DeleteAppData == ${BST_CHECKED}
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
      ${EndIf}
    ${Else}
      DetailPrint "No app data found to delete"
    ${EndIf}
  ${Else}
    DetailPrint "Keeping saved app data"
  ${EndIf}
FunctionEnd 