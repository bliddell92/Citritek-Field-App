/**
 * Citritek Unified Field App — Storage Layer
 * ==========================================
 *
 * Evolved from the Bristol Water app's storage.js. Same principle: this is
 * the ONLY module in the app that talks to IndexedDB. Everything else uses
 * these wrappers. When we eventually move to a real backend, this file is
 * the only one that changes.
 *
 * WHAT'S DIFFERENT FROM THE BW VERSION
 * ------------------------------------
 *
 * 1. Database name is `ctk_field_app`, NOT `bw_field_app`.
 *    This matters more than it looks. GitHub Pages serves every repo from
 *    the same origin (bliddell92.github.io), and IndexedDB is scoped to
 *    ORIGIN, not to folder. So the unified app at /citritek-field-app can
 *    see — and could corrupt — the live BW app's database at
 *    /Bristol-Water---Quarterly. Using a separate DB name is what keeps the
 *    live app genuinely untouched. Nothing here ever opens `bw_field_app`.
 *
 * 2. Every write throws on failure. The install app swallowed storage
 *    errors into a toast and carried on with unsaved data in memory —
 *    that's how a day's work was lost. Nothing in this file catches and
 *    discards a write error.
 *
 * 3. Photos know which work item they belong to, not just which visit.
 *
 * 4. Reference data is generic — register a source, load it by name —
 *    rather than hardcoded to the three BW files.
 *
 * 5. Lookups store: remembers client/site/technician values typed on this
 *    device so the setup screen can offer them back. Stops the same site
 *    becoming three different spellings across three reports.
 */

(function (global) {
  'use strict';

  const BUILD = '0.6.3';   // must match ctk_schema.js and index.html

  const DB_NAME = 'ctk_field_app';
  const DB_VERSION = 1;

  const STORE_VISITS = 'visits';
  const STORE_PHOTOS = 'photos';
  const STORE_REFDATA = 'refdata';
  const STORE_LOOKUPS = 'lookups';

  // Guard: this name must never be opened by this module.
  const FORBIDDEN_DB = 'bw_field_app';

  let REFERENCE_BASE_URL = '';

  // Registry of reference data sources. Work types declare which one they
  // need via CTKSchema.WORK_TYPES[...].reference.
  const REFERENCE_SOURCES = {
    bw_sites:     { file: 'bw_sites.json',        required: true,  fallback: null },
    bw_remedials: { file: 'bw_remedials.json',    required: true,  fallback: null },
    bw_devices:   { file: 'bw_devices.json',      required: false, fallback: { schema_version: 1, devices: [] } },
    processed:    { file: 'processed_visits.json',required: false, fallback: { items: [] } },
  };

  const AUTO_CLEAR_FALLBACK_DAYS = 30;
  const MAX_SUGGESTIONS = 8;

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;

    if (DB_NAME === FORBIDDEN_DB) {
      throw new Error('Refusing to open the live Bristol Water database.');
    }

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_VISITS)) {
          const visits = db.createObjectStore(STORE_VISITS, { keyPath: 'visit_id' });
          visits.createIndex('status', 'status', { unique: false });
          visits.createIndex('date', 'date', { unique: false });
          visits.createIndex('client', 'client', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
          const photos = db.createObjectStore(STORE_PHOTOS, { keyPath: 'photo_id' });
          photos.createIndex('visit_id', 'visit_id', { unique: false });
          photos.createIndex('work_item_id', 'work_item_id', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_REFDATA)) {
          db.createObjectStore(STORE_REFDATA, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORE_LOOKUPS)) {
          db.createObjectStore(STORE_LOOKUPS, { keyPath: 'field' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return _dbPromise;
  }

  async function tx(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      let failed = false;
      Promise.resolve(fn(store))
        .then((r) => { result = r; })
        .catch((e) => { failed = true; try { transaction.abort(); } catch (_) {} reject(e); });
      transaction.oncomplete = () => { if (!failed) resolve(result); };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => { if (!failed) reject(transaction.error || new Error('transaction aborted')); };
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------------------------------------------------------------------
  // Reference data
  // ---------------------------------------------------------------------------

  function urlFor(file) {
    return REFERENCE_BASE_URL ? `${REFERENCE_BASE_URL}/${file}` : file;
  }

  async function fetchJSON(url) {
    const sep = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${sep}_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    return await response.json();
  }

  async function getCachedRef(key) {
    return tx(STORE_REFDATA, 'readonly', async (store) => {
      const rec = await reqToPromise(store.get(key));
      return rec ? rec.value : null;
    });
  }

  async function setCachedRef(key, value) {
    return tx(STORE_REFDATA, 'readwrite', async (store) => {
      await reqToPromise(store.put({ key, value, cached_at: new Date().toISOString() }));
    });
  }

  /**
   * Fetch every registered reference source and refresh the cache.
   * Returns { fresh, errors: {name: message} }. `fresh` is true only if
   * every REQUIRED source came down cleanly — optional sources missing is
   * a normal state, not a failure.
   */
  async function refreshReferenceData() {
    const errors = {};
    let requiredOk = true;

    await Promise.all(Object.keys(REFERENCE_SOURCES).map(async (name) => {
      const src = REFERENCE_SOURCES[name];
      try {
        const data = await fetchJSON(urlFor(src.file));
        await setCachedRef(name, data);
      } catch (err) {
        errors[name] = String(err);
        if (src.required) requiredOk = false;
        else if (src.fallback && !(await getCachedRef(name))) {
          await setCachedRef(name, src.fallback);
        }
      }
    }));

    return { fresh: requiredOk, errors };
  }

  /**
   * Load one reference source by name, from cache, bootstrapping over the
   * network if there's nothing cached yet.
   */
  async function loadRef(name) {
    const src = REFERENCE_SOURCES[name];
    if (!src) throw new Error('Unknown reference source: ' + name);

    const cached = await getCachedRef(name);
    if (cached) return cached;

    const result = await refreshReferenceData();
    const afterFetch = await getCachedRef(name);
    if (afterFetch) return afterFetch;

    if (src.fallback) return src.fallback;
    throw new Error(
      'No cached "' + name + '" and could not fetch it. ' + (result.errors[name] || '')
    );
  }

  // Convenience wrappers, so existing BW call sites read the same.
  const loadSites = () => loadRef('bw_sites');
  const loadRemedials = () => loadRef('bw_remedials');
  const loadDevices = () => loadRef('bw_devices');
  const loadProcessedVisits = () => loadRef('processed');

  // ---------------------------------------------------------------------------
  // Visits
  // ---------------------------------------------------------------------------

  async function saveVisit(visit) {
    if (!visit || !visit.visit_id) {
      throw new Error('saveVisit: visit must already have a visit_id (use CTKSchema.createVisit)');
    }
    visit.updated_at = new Date().toISOString();
    await tx(STORE_VISITS, 'readwrite', async (store) => {
      await reqToPromise(store.put(visit));
    });
    return visit;
  }

  async function getVisit(visitId) {
    return tx(STORE_VISITS, 'readonly', async (store) =>
      (await reqToPromise(store.get(visitId))) || null
    );
  }

  async function getAllVisits() {
    return tx(STORE_VISITS, 'readonly', async (store) => {
      const all = await reqToPromise(store.getAll());
      return all.sort((a, b) => {
        const ad = a.date || a.created_at || '';
        const bd = b.date || b.created_at || '';
        if (ad === bd) return (b.created_at || '').localeCompare(a.created_at || '');
        return bd.localeCompare(ad);
      });
    });
  }

  async function getVisitsByStatus(status) {
    return tx(STORE_VISITS, 'readonly', async (store) =>
      await reqToPromise(store.index('status').getAll(status))
    );
  }

  async function deleteVisit(visitId) {
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      const photos = await reqToPromise(store.index('visit_id').getAll(visitId));
      for (const p of photos) await reqToPromise(store.delete(p.photo_id));
    });
    await tx(STORE_VISITS, 'readwrite', async (store) => {
      await reqToPromise(store.delete(visitId));
    });
  }

  // ---------------------------------------------------------------------------
  // Work items
  // ---------------------------------------------------------------------------

  async function addWorkItem(visitId, workItem) {
    const visit = await getVisit(visitId);
    if (!visit) throw new Error('addWorkItem: no visit ' + visitId);
    visit.work_items = visit.work_items || [];
    visit.work_items.push(workItem);
    await saveVisit(visit);
    return workItem;
  }

  async function getWorkItem(visitId, workItemId) {
    const visit = await getVisit(visitId);
    if (!visit) return null;
    return (visit.work_items || []).find((wi) => wi.work_item_id === workItemId) || null;
  }

  /**
   * Patch a work item. `patch` is merged shallowly at the top level; to
   * change the data block pass { data: {...} } with the full new data.
   */
  async function updateWorkItem(visitId, workItemId, patch) {
    const visit = await getVisit(visitId);
    if (!visit) throw new Error('updateWorkItem: no visit ' + visitId);
    const idx = (visit.work_items || []).findIndex((wi) => wi.work_item_id === workItemId);
    if (idx === -1) throw new Error('updateWorkItem: no work item ' + workItemId);
    visit.work_items[idx] = Object.assign({}, visit.work_items[idx], patch, {
      work_item_id: workItemId,
      type: visit.work_items[idx].type,
      updated_at: new Date().toISOString(),
    });
    await saveVisit(visit);
    return visit.work_items[idx];
  }

  /**
   * Remove a work item and its photos. If it was the only work item the
   * visit is left empty rather than deleted — the technician may want to
   * pick a different job type without re-entering site details.
   */
  async function deleteWorkItem(visitId, workItemId) {
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      const photos = await reqToPromise(store.index('work_item_id').getAll(workItemId));
      for (const p of photos) await reqToPromise(store.delete(p.photo_id));
    });
    const visit = await getVisit(visitId);
    if (!visit) return;
    visit.work_items = (visit.work_items || []).filter((wi) => wi.work_item_id !== workItemId);
    await saveVisit(visit);
  }

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  async function addPhoto(visitId, workItemId, blob) {
    if (!blob) throw new Error('addPhoto: no blob supplied');
    const photoId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      await reqToPromise(store.put({
        photo_id: photoId,
        visit_id: visitId,
        work_item_id: workItemId || null,
        blob: blob,
        captured_at: new Date().toISOString(),
      }));
    });
    return photoId;
  }

  async function getPhoto(photoId) {
    return tx(STORE_PHOTOS, 'readonly', async (store) =>
      (await reqToPromise(store.get(photoId))) || null
    );
  }

  async function getPhotosForVisit(visitId) {
    return tx(STORE_PHOTOS, 'readonly', async (store) =>
      await reqToPromise(store.index('visit_id').getAll(visitId))
    );
  }

  async function getPhotosForWorkItem(workItemId) {
    return tx(STORE_PHOTOS, 'readonly', async (store) =>
      await reqToPromise(store.index('work_item_id').getAll(workItemId))
    );
  }

  async function deletePhoto(photoId) {
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      await reqToPromise(store.delete(photoId));
    });
  }

  // ---------------------------------------------------------------------------
  // Lookups — remembered free-text values for the typed setup screen
  // ---------------------------------------------------------------------------

  /**
   * Record a value the technician typed, so it can be suggested next time.
   * Values are stored with a use count and last-used date; suggestions come
   * back most-used first, so the sites someone visits often float to the top.
   */
  async function rememberValue(field, value) {
    const clean = String(value || '').trim();
    if (!clean) return;
    await tx(STORE_LOOKUPS, 'readwrite', async (store) => {
      const rec = (await reqToPromise(store.get(field))) || { field, values: [] };
      const existing = rec.values.find((v) => v.value.toLowerCase() === clean.toLowerCase());
      if (existing) {
        existing.count += 1;
        existing.last_used = new Date().toISOString();
      } else {
        rec.values.push({ value: clean, count: 1, last_used: new Date().toISOString() });
      }
      await reqToPromise(store.put(rec));
    });
  }

  async function getSuggestions(field, prefix) {
    const rec = await tx(STORE_LOOKUPS, 'readonly', async (store) =>
      await reqToPromise(store.get(field))
    );
    if (!rec) return [];
    const p = String(prefix || '').trim().toLowerCase();
    return rec.values
      .filter((v) => !p || v.value.toLowerCase().includes(p))
      .sort((a, b) => (b.count - a.count) || b.last_used.localeCompare(a.last_used))
      .slice(0, MAX_SUGGESTIONS)
      .map((v) => v.value);
  }

  async function forgetValue(field, value) {
    await tx(STORE_LOOKUPS, 'readwrite', async (store) => {
      const rec = await reqToPromise(store.get(field));
      if (!rec) return;
      rec.values = rec.values.filter((v) => v.value.toLowerCase() !== String(value).toLowerCase());
      await reqToPromise(store.put(rec));
    });
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  async function runAutoClear() {
    let processed;
    try { processed = await loadProcessedVisits(); } catch (_) { processed = { items: [] }; }
    const processedIds = new Set((processed.items || []).map((it) => it.visit_id || it));

    const exported = await getVisitsByStatus('exported');
    let byOffice = 0, byFallback = 0;
    const cutoff = new Date(Date.now() - AUTO_CLEAR_FALLBACK_DAYS * 864e5);

    for (const visit of exported) {
      if (processedIds.has(visit.visit_id)) {
        await deleteVisit(visit.visit_id);
        byOffice++;
        continue;
      }
      const at = visit.exported_at ? new Date(visit.exported_at) : null;
      if (at && at < cutoff) {
        await deleteVisit(visit.visit_id);
        byFallback++;
      }
    }
    return { cleared_by_office: byOffice, cleared_by_fallback: byFallback };
  }

  /**
   * Rough storage usage, for the home-screen indicator. Returns null where
   * the browser doesn't support the estimate API rather than guessing.
   */
  async function storageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const est = await navigator.storage.estimate();
      return { used: est.usage || 0, quota: est.quota || 0 };
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Dev/test
  // ---------------------------------------------------------------------------

  async function _wipeDatabase() {
    try { const db = await openDB(); db.close(); } catch (_) {}
    _dbPromise = null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('delete blocked — close other tabs'));
    });
  }

  function _setReferenceURL(url) { REFERENCE_BASE_URL = url; }

  const CTKStorage = {
    BUILD,
    DB_NAME,
    loadRef, refreshReferenceData,
    loadSites, loadRemedials, loadDevices, loadProcessedVisits,
    saveVisit, getVisit, getAllVisits, getVisitsByStatus, deleteVisit,
    addWorkItem, getWorkItem, updateWorkItem, deleteWorkItem,
    addPhoto, getPhoto, getPhotosForVisit, getPhotosForWorkItem, deletePhoto,
    rememberValue, getSuggestions, forgetValue,
    runAutoClear, storageEstimate,
    _wipeDatabase, _setReferenceURL,
  };

  global.CTKStorage = CTKStorage;
  if (typeof module !== 'undefined' && module.exports) module.exports = CTKStorage;
})(typeof window !== 'undefined' ? window : globalThis);
