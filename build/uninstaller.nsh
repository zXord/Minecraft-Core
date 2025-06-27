!include nsDialogs.nsh
XPStyle on

# Custom uninstall script that adds a checkbox for user data deletion
Var /GLOBAL Dialog_1
Var /GLOBAL VLine
Var /GLOBAL Label_1
Var /GLOBAL Label_2
Var /GLOBAL Label_3
Var /GLOBAL CheckBox_1
Var /GLOBAL Checkbox_State

# Create a custom uninstall page
UninstPage custom un.nsDialogsPage un.nsDialogsPageLeave

Function un.nsDialogsPage
    nsDialogs::Create 1018
    Pop $Dialog_1
    ${If} $Dialog_1 == error
        Abort
    ${EndIf}
    
    # Create visual elements
    ${NSD_CreateVLine} 0 30u 100% 12u ""
    Pop $VLine
    
    ${NSD_CreateLabel} 0 10u 100% 12u "Remove User Data?"
    Pop $Label_1
    
    ${NSD_CreateLabel} 10u 35u 100% 12u "Your Minecraft servers, worlds, configurations, and downloaded mods will be preserved"
    Pop $Label_2
    
    ${NSD_CreateLabel} 10u 50u 100% 12u "unless you check the box below."
    Pop $Label_3
    
    ${NSD_CreateCheckbox} 0 70u 100% 10u "&Delete all Minecraft Core data (servers, worlds, mods, configurations)"
    Pop $CheckBox_1
    
    nsDialogs::Show
FunctionEnd

Function un.nsDialogsPageLeave
    ${NSD_GetState} $CheckBox_1 $Checkbox_State
FunctionEnd

!macro customUnInstall
    # Custom uninstall logic
    ${ifNot} ${isUpdated}
        # Check if user wants to delete local data
        ${If} $Checkbox_State == 1
            SetShellVarContext current
            
            # Delete AppData folder for this app
            RMDir /r "$APPDATA\minecraft-core"
            
            # Delete LocalAppData folder for this app  
            RMDir /r "$LOCALAPPDATA\minecraft-core"
            
            # Delete any data in Documents (if app stores data there)
            RMDir /r "$DOCUMENTS\Minecraft Core"
            
            # Delete any temporary files
            RMDir /r "$TEMP\minecraft-core"
            
            # Optional: Show confirmation that data was deleted
            # MessageBox MB_OK "All Minecraft Core user data has been removed."
        ${Else}
            # Optional: Show message that data was preserved
            # MessageBox MB_OK "Your Minecraft Core data has been preserved and will be available if you reinstall."
        ${EndIf}
    ${endIf}
!macroend 