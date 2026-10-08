function createOrderlyQuitBarrier({ dispose, quit, onDisposeError = () => {} } = {}) {
  if (typeof dispose !== 'function' || typeof quit !== 'function' || typeof onDisposeError !== 'function') {
    throw new TypeError('Orderly quit barrier requires disposal, quit, and error callbacks');
  }

  let disposalPromise = null;
  let allowQuitReentry = false;

  function handleBeforeQuit(event) {
    if (allowQuitReentry) return false;
    if (!event || typeof event.preventDefault !== 'function') {
      throw new TypeError('Orderly quit barrier requires a cancellable before-quit event');
    }
    event.preventDefault();
    if (disposalPromise) return true;

    let disposal;
    try { disposal = dispose(); }
    catch (error) { disposal = Promise.reject(error); }
    disposalPromise = Promise.resolve(disposal)
      .catch(error => {
        try { onDisposeError(error); }
        catch { /* error reporting cannot strand application shutdown */ }
      })
      .then(() => {
        allowQuitReentry = true;
        quit();
      });
    return true;
  }

  return Object.freeze({ handleBeforeQuit });
}

module.exports = { createOrderlyQuitBarrier };
