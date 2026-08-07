function createCoordinatedBrowserHandlers({ mutationPolicy, ...handlerGroups } = {}) {
  if (!mutationPolicy || typeof mutationPolicy.wrapHandlers !== 'function') {
    throw new TypeError('A server mutation policy is required');
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(handlerGroups).map(([groupName, handlers]) => {
      if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
        throw new TypeError(`Invalid browser handler group: ${groupName}`);
      }
      return [groupName, Object.freeze(mutationPolicy.wrapHandlers(handlers))];
    })
  ));
}

module.exports = { createCoordinatedBrowserHandlers };
