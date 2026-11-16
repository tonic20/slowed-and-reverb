async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('slowed-reverb-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function storedFile(action, file, key = 'current') {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', action === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('files');
      const request = action === 'get' ? store.get(key) : action === 'put' ? store.put(file, key) : store.delete(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error('File storage was interrupted.'));
    });
  } finally {
    db.close();
  }
}
