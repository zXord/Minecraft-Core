export async function saveInstances(instances) {
  try {
    const validInstances = instances.filter(instance => {
      if (instance.type === 'server' && (!instance.path || instance.path.trim() === '')) {
        return false;
      }
      return true;
    });

    const result = await window.electron.invoke('save-instances', validInstances);
    if (!result || !result.success) {
      console.error('Failed to save instances:', result?.error || 'Unknown error');
    }
  } catch (err) {
    console.error('Failed to save instances:', err);
  }
}
