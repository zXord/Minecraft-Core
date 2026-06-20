function shouldUseDevServer({
  isPackaged = false,
  enableDevServer = false,
  lifecycleEvent = '',
  forceDevServer = false
} = {}) {
  if (enableDevServer || forceDevServer) {
    return true;
  }

  if (isPackaged) {
    return false;
  }

  return lifecycleEvent === 'dev' || lifecycleEvent === 'dev:electron';
}

module.exports = {
  shouldUseDevServer
};
