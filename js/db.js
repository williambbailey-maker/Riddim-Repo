/* Riddim Repo — IndexedDB, used as a local audio cache.
   Track metadata lives in the cloud (Supabase); this store keeps audio
   blobs on-device so playback is instant and works offline. Records
   from the pre-cloud era also carry metadata, which the app migrates
   up to the cloud on first login. */

const RiddimDB = (() => {
  const DB_NAME = 'riddim';
  const DB_VERSION = 1;
  const STORE = 'tracks';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    put(record) {
      return tx('readwrite', store => store.put(record));
    },

    /** Every full record, blobs included (used for legacy migration). */
    async getAllRecords() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async get(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    delete(id) {
      return tx('readwrite', store => store.delete(id));
    },
  };
})();
