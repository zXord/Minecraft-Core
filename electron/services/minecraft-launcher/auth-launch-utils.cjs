function getAuthErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return String(error || 'Unknown error');
}

function shouldFallbackToEmbeddedMicrosoftAuth(error) {
  const message = getAuthErrorMessage(error).toLowerCase();

  return (
    message.includes('error.gui.raw.nobrowser') ||
    message.includes('no chromium browser was set') ||
    message.includes('spawn ') ||
    message.includes('enoent') ||
    message.includes('eacces')
  );
}

module.exports = {
  getAuthErrorMessage,
  shouldFallbackToEmbeddedMicrosoftAuth
};
