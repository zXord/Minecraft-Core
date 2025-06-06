function safeAsync(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { success: false, error: error.message };
    }
  };
}

module.exports = { safeAsync };
