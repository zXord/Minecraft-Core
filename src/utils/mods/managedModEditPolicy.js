export const MANAGED_MOD_EDIT_MESSAGE = 'Individual mod changes are disabled while this server is managed. Use Modpack to change or repair the pack, or review Detach to keep all files and manage mods individually.';

export function modJarEditsBlocked(managed, contentType = 'mods') {
  return contentType === 'mods' && managed !== false;
}
