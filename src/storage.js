export function createPersistedSelection(selection) {
  return {
    ...selection,
    screenImage: ''
  };
}

export function writeJsonStorage(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return { ok: true, message: '' };
  } catch (error) {
    return {
      ok: false,
      message: isQuotaError(error)
        ? '浏览器存储空间不足，照片已加入本次页面，刷新后需要重新上传。'
        : '浏览器本地存储失败，照片已加入本次页面。'
    };
  }
}

export function isQuotaError(error) {
  return (
    error?.name === 'QuotaExceededError' ||
    error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error?.code === 22 ||
    error?.code === 1014
  );
}
