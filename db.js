// 모든 기록은 이 기기의 브라우저(IndexedDB) 안에만 저장됩니다.
const DB_NAME = 'question-coach';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('students')) db.createObjectStore('students', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('studentId', 'studentId');
        s.createIndex('day', 'day');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'day' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export const db = {
  put: (store, value) => tx(store, 'readwrite', s => reqP(s.put(value))),
  get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
  del: (store, key) => tx(store, 'readwrite', s => reqP(s.delete(key))),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  byIndex: (store, index, value) => tx(store, 'readonly', s => reqP(s.index(index).getAll(value))),
};

export function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 한국 시간 기준 날짜 문자열 (YYYY-MM-DD)
export function dayOf(ts) {
  const d = new Date(ts);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
