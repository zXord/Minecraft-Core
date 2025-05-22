# Minecraft Core Feature Implementation Prompt

## Overview
Implement three new features for the Minecraft Core application:

1. Rename instances from the panel view
2. Delete instances from the settings page
3. On deletion, include an option to delete the entire server path directory

## Codebase Structure

The app is built with:
- Svelte for the frontend
- Electron for the desktop application framework
- Electron Store for persistent data storage

Key files for modification:

### Frontend Files
- `src/App.svelte` - Main UI that handles instance selection and sidebar
- `src/components/settings/ServerPropertiesEditor.svelte` - Example settings component 
- `src/components/settings/WorldSettings.svelte` - Contains the "danger zone" UI pattern we should follow

### Backend Files
- `electron/utils/app-store.cjs` - Manages persistent storage of instances
- `electron/ipc/settings-handlers.cjs` - Handles IPC communication for settings and instances

## Current Implementation
- Instances are stored in Electron Store under the `instances` key
- Each instance has: `id`, `name`, `type`, and for server instances, a `path` property
- The UI shows instances in a sidebar list with minimal interaction
- Users can add new instances but can't rename or delete existing ones

## Feature 1: Rename Instances
### Requirements
1. Add the ability to rename instances directly from the panel view (sidebar)
2. Add an edit button next to each instance name
3. When clicked, show an inline input for renaming
4. Update the instance name in the store upon confirmation

### Implementation Details
- Add rename buttons next to instance names in `App.svelte`
- Create inline editing functionality in the sidebar
- Update the `name` property in the electron store via IPC

## Feature 2: Delete Instances
### Requirements
1. Add a "Danger Zone" section to the settings page
2. Include a "Delete Instance" button with proper warning
3. Show a confirmation dialog before deletion
4. Remove the instance from the app-store upon confirmation

### Implementation Details
- Create a new component `src/components/settings/InstanceSettings.svelte`
- Follow the pattern used in `WorldSettings.svelte` for the danger zone UI
- Add a delete button with confirmation dialog
- Use IPC to remove the instance from store

## Feature 3: Delete Server Path on Instance Deletion
### Requirements
1. In the delete confirmation dialog, add a checkbox to "Delete server files completely"
2. If checked, delete the entire folder specified in the instance's `path` property
3. If not checked, just remove the instance from the store

### Implementation Details
- Add a file deletion handler in `electron/ipc/settings-handlers.cjs`
- Use Node.js `fs.rm` with `recursive: true` option for deletion
- Consider adding a backup option before deletion

## UI Guidelines
- For the danger zone, use red border/background: `border: 1px solid #ff5555; background: rgba(255, 0, 0, 0.1);`
- For danger buttons, use red styling: `background: rgba(255, 0, 0, 0.2); border: 1px solid rgba(255, 0, 0, 0.3);`
- Add appropriate warning text: "These actions cannot be undone. Please be careful."
- All dangerous actions should have confirmation dialogs

## Code Structure
1. Create new IPC handlers for:
   - Rename instance
   - Delete instance
   - Delete server directory
2. Add UI components for rename and delete functionality
3. Update the electron store when instances are modified

## Expected Deliverables
- Modified `App.svelte` with rename functionality
- New `InstanceSettings.svelte` component with delete functionality
- New IPC handlers in `settings-handlers.cjs`
- Complete implementation that meets all requirements

## Testing Instructions
- Test renaming instances and verify the name persists after app restart
- Test deleting instances both with and without the "delete server files" option
- Ensure appropriate error handling for file deletion operations
