/* Riddim — IndexedDB storage for audio tracks.
   Tracks (including the audio blob itself) live entirely in the browser,
   so the library works offline and survives reloads. */

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
    /** Store or update a full track record (including blob). */
    put(track) {
      return tx('readwrite', store => store.put(track));
    },

    /** All track records, without their blobs (kept light for the library view). */
    async getAllMeta() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => {
          resolve(req.result.map(({ blob, ...meta }) => meta));
        };
        req.onerror = () => reject(req.error);
      });
    },

    /** One full record, blob included — used when actually playing a track. */
    async get(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    /** Update metadata fields on an existing record, leaving the blob alone. */
    async patch(id, fields) {
      const record = await this.get(id);
      if (!record) throw new Error('Track not found: ' + id);
      Object.assign(record, fields);
      await this.put(record);
      const { blob, ...meta } = record;
      return meta;
    },

    delete(id) {
      return tx('readwrite', store => store.delete(id));
    },
  };
})();
