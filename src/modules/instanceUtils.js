export async function saveInstances(instances) {
  const validInstances = instances.filter(instance => {
    if (instance.type === 'server' && (!instance.path || instance.path.trim() === '')) {
      return false;
    }
    return true;
  });

  await window.electron.invoke('save-instances', validInstances);
}
