/**
 * Citritek Unified Field App — Schema & Envelope
 * ==============================================
 *
 * This module defines the shared shape that every work type plugs into.
 * It contains NO storage code and NO UI code — it is pure data definition
 * and transformation, so it can be tested in isolation and reused by the
 * office-side tooling if we ever want to.
 *
 * The three things defined here:
 *
 *   1. WORK_TYPES     — the registry. Adding a new job type (tank inspection,
 *                       Legionella RA) starts by adding an entry here.
 *
 *   2. The envelope   — Visit { client, site, date, technician, work_items[] }
 *                       One visit = one site, one date, one technician.
 *                       A multi-day install is several visits, merged in the
 *                       office. A site where two jobs happen on the same day
 *                       is ONE visit with two work items.
 *
 *   3. Legacy adapters — toLegacyBW() and toLegacyInstall() convert a unified
 *                       bundle back into the exact shape the existing Python
 *                       and Node generators already read. This is what lets
 *                       us change the app without touching either generator.
 */

(function (global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const EXPORT_TYPE = 'ctk_field_bundle';

  // ---------------------------------------------------------------------------
  // Work type registry
  // ---------------------------------------------------------------------------
  //
  // site_source:
  //   'reference' — site comes from a dropdown backed by a reference JSON file.
  //                 The app must resolve the site to load its outlets/subtasks.
  //   'typed'     — technician types client/site/etc on a setup screen.
  //
  // client_locked: if set, the client is fixed and not asked for.
  //
  // status:
  //   'live'    — built and usable
  //   'planned' — registered but not yet built; shown greyed out in the app
  //
  // generator: which office-side tool consumes this work item's bundle.

  const WORK_TYPES = {
    bw_quarterly: {
      label: 'Bristol Water — Quarterly C&D',
      short: 'BW Quarterly',
      site_source: 'reference',
      reference: 'bw_sites',
      client_locked: 'Bristol Water',
      generator: 'bw_report_generator.py',
      legacy_export: 'bw',
      status: 'live',
    },
    bw_six_monthly: {
      label: 'Bristol Water — Six-Monthly',
      short: 'BW Six-Monthly',
      site_source: 'reference',
      reference: 'bw_sites',
      client_locked: 'Bristol Water',
      generator: 'bw_report_generator.py',
      legacy_export: 'bw',
      status: 'live',
    },
    bw_annual: {
      label: 'Bristol Water — Annual',
      short: 'BW Annual',
      site_source: 'reference',
      reference: 'bw_sites',
      client_locked: 'Bristol Water',
      generator: 'bw_report_generator.py',
      legacy_export: 'bw',
      status: 'live',
    },
    bw_combined: {
      label: 'Bristol Water — Combined',
      short: 'BW Combined',
      site_source: 'reference',
      reference: 'bw_sites',
      client_locked: 'Bristol Water',
      generator: 'bw_report_generator.py',
      legacy_export: 'bw',
      status: 'live',
    },
    installation: {
      label: 'Device Installation',
      short: 'Installation',
      site_source: 'typed',
      reference: null,
      client_locked: null,
      generator: 'generate_install_report.js',
      legacy_export: 'install',
      status: 'live',
    },
    tank_inspection: {
      label: 'Tank Inspection & Sampling',
      short: 'Tank Inspection',
      site_source: 'typed',
      reference: null,
      client_locked: null,
      generator: null,
      legacy_export: null,
      status: 'planned',
    },
    temperature_monitoring: {
      label: 'Temperature Monitoring',
      short: 'Temp Monitoring',
      site_source: 'typed',
      reference: null,
      client_locked: null,
      generator: null,
      legacy_export: null,
      status: 'planned',
    },
    legionella_ra: {
      label: 'Legionella Risk Assessment',
      short: 'Legionella RA',
      site_source: 'typed',
      reference: null,
      client_locked: null,
      generator: null,
      legacy_export: null,
      status: 'planned',
    },
  };

  function workType(type) {
    return WORK_TYPES[type] || null;
  }

  function liveWorkTypes() {
    return Object.keys(WORK_TYPES).filter((k) => WORK_TYPES[k].status === 'live');
  }

  function isBWType(type) {
    const wt = WORK_TYPES[type];
    return !!wt && wt.legacy_export === 'bw';
  }

  // ---------------------------------------------------------------------------
  // ID generation
  // ---------------------------------------------------------------------------

  function genId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 10);
  }

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  /**
   * Create a new visit. client/site/date/technician are the envelope — they
   * are asked for ONCE and every work item inside inherits them.
   */
  function createVisit(fields) {
    const f = fields || {};
    if (!f.date) throw new Error('createVisit: date is required');
    if (!f.technician) throw new Error('createVisit: technician is required');
    if (!f.site) throw new Error('createVisit: site is required');

    return {
      visit_id: f.visit_id || genId('v'),
      schema_version: SCHEMA_VERSION,
      status: 'in_progress',

      // --- the envelope ---
      client: f.client || '',
      site: f.site,
      site_ref: f.site_ref || null,   // key into reference data, when applicable
      address: f.address || '',
      date: f.date,
      technician: f.technician,

      work_items: [],

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exported_at: null,

      meta: {
        app_version: f.app_version || null,
        client_is_new: !!f.client_is_new,   // flagged when typed via "+ New client"
      },
    };
  }

  /**
   * Create a work item to sit inside a visit. `data` is the type-specific
   * payload — the envelope knows nothing about its contents.
   */
  function createWorkItem(type, data) {
    const wt = WORK_TYPES[type];
    if (!wt) throw new Error('createWorkItem: unknown work type "' + type + '"');
    if (wt.status !== 'live') {
      throw new Error('createWorkItem: work type "' + type + '" is not built yet');
    }
    return {
      work_item_id: genId('wi'),
      type: type,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      data: data || emptyDataFor(type),
    };
  }

  /**
   * The empty starting shape for each work type's data block. Keeping these
   * here means the storage layer never has to know work-type specifics.
   */
  function emptyDataFor(type) {
    if (isBWType(type)) {
      return {
        visit_type: type.replace(/^bw_/, ''),
        task_results: [],
        new_assets: [],
        pending_remedials: [],
        remedial_changes: [],
        device_records: [],
      };
    }
    if (type === 'installation') {
      return {
        block: '',
        ref: '',
        report_date: null,
        sections: [],     // [{ id, name, devices: [{ id, code, name, status, notes, channels, photo_ids }] }]
        gateways: [],     // [{ id, code, location, status, photo_ids }]
      };
    }
    return {};
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Returns an array of problem strings. Empty array means valid.
   * Deliberately returns problems rather than throwing, so the UI can show
   * all of them at once rather than one at a time.
   */
  function validateVisit(v) {
    const problems = [];
    if (!v || typeof v !== 'object') return ['visit is not an object'];

    if (!v.visit_id) problems.push('missing visit_id');
    if (v.schema_version !== SCHEMA_VERSION) {
      problems.push('schema_version is ' + v.schema_version + ', expected ' + SCHEMA_VERSION);
    }
    if (!v.site) problems.push('missing site');
    if (!v.date) problems.push('missing date');
    if (!v.technician) problems.push('missing technician');
    if (!['in_progress', 'complete', 'exported'].includes(v.status)) {
      problems.push('invalid status: ' + v.status);
    }
    if (!Array.isArray(v.work_items)) {
      problems.push('work_items is not an array');
      return problems;
    }
    if (v.work_items.length === 0) problems.push('visit has no work items');

    const seen = new Set();
    v.work_items.forEach((wi, i) => {
      const at = 'work_items[' + i + ']';
      if (!wi.work_item_id) problems.push(at + ' missing work_item_id');
      if (seen.has(wi.work_item_id)) problems.push(at + ' duplicate work_item_id');
      seen.add(wi.work_item_id);
      if (!WORK_TYPES[wi.type]) problems.push(at + ' unknown type "' + wi.type + '"');
      if (!wi.data || typeof wi.data !== 'object') problems.push(at + ' missing data block');
    });

    // A visit carrying BW work items must have a resolved site_ref, otherwise
    // the generator can't match it back to bw_sites.json.
    if (v.work_items.some((wi) => isBWType(wi.type)) && !v.site_ref) {
      problems.push('BW work item present but site_ref is not set');
    }

    return problems;
  }

  // ---------------------------------------------------------------------------
  // Bundle
  // ---------------------------------------------------------------------------

  function buildBundleEnvelope(visits, opts) {
    const o = opts || {};
    return {
      exportType: EXPORT_TYPE,
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      app_version: o.app_version || null,
      device_label: o.device_label || null,
      visit_count: visits.length,
      work_item_count: visits.reduce((n, v) => n + (v.work_items || []).length, 0),
      work_types: Array.from(
        new Set(visits.flatMap((v) => (v.work_items || []).map((wi) => wi.type)))
      ).sort(),
      visits: visits,
    };
  }

  /**
   * Split a unified bundle into one sub-bundle per legacy generator, so the
   * office can drop each into the tool that already exists. Returns e.g.
   *   { bw: {...legacy bw bundle...}, install: [ {...}, {...} ] }
   * Keys are omitted entirely when there's nothing of that type.
   */
  function splitForGenerators(bundle) {
    const out = {};
    const bwVisits = [];
    const installVisits = [];

    for (const v of bundle.visits || []) {
      for (const wi of v.work_items || []) {
        if (isBWType(wi.type)) bwVisits.push({ visit: v, item: wi });
        else if (wi.type === 'installation') installVisits.push({ visit: v, item: wi });
      }
    }

    if (bwVisits.length) out.bw = toLegacyBW(bwVisits, bundle);
    if (installVisits.length) out.install = installVisits.map((p) => toLegacyInstall(p, bundle));
    return out;
  }

  /**
   * Rebuild the exact bundle shape that bw_report_generator.py already reads
   * (exportType 'bw_field_report', schema_version 3, flat visits array with
   * task_results at visit level). Nothing in the Python changes.
   */
  function toLegacyBW(pairs, bundle) {
    const visits = pairs.map(({ visit, item }) => ({
      visit_id: visit.visit_id,
      status: visit.status,
      visit_type: item.data.visit_type || item.type.replace(/^bw_/, ''),
      site: visit.site_ref || visit.site,
      date: visit.date,
      technician: visit.technician,
      created_at: visit.created_at,
      updated_at: visit.updated_at,
      task_results: item.data.task_results || [],
      new_assets: item.data.new_assets || [],
      pending_remedials: item.data.pending_remedials || [],
      remedial_changes: item.data.remedial_changes || [],
      device_records: item.data.device_records || [],
    }));

    const first = visits[0] || {};
    return {
      exportType: 'bw_field_report',
      schema_version: 3,
      exportedAt: bundle.exported_at,
      technician: first.technician || 'Unknown',
      day: first.date,
      visit_count: visits.length,
      visits: visits,
    };
  }

  /**
   * Rebuild the shape generate_install_report.js already reads:
   *   { job: { site, client, tech, dates, gateways[] }, devices: [...] }
   * One install work item produces one legacy job bundle. Multi-day installs
   * produce several, which merger.html combines — same as today.
   */
  function toLegacyInstall(pair, bundle) {
    const v = pair.visit;
    const d = pair.item.data || {};

    const devices = [];
    for (const section of d.sections || []) {
      for (const dev of section.devices || []) {
        devices.push({
          code: dev.code || '',
          name: dev.name || '',
          section: section.name || '',
          status: dev.status || null,
          notes: dev.notes || '',
          channels: dev.channels || [],
          photos: dev.photos || [],
          ts: dev.ts || null,
        });
      }
    }

    return {
      job: {
        site: v.site,
        client: v.client || '',
        address: v.address || '',
        block: d.block || '',
        tech: v.technician,
        dates: v.date,
        reportDate: d.report_date || v.date,
        ref: d.ref || '',
        gateways: (d.gateways || []).map((gw) => ({
          id: gw.id,
          code: gw.code || '',
          location: gw.location || '',
          status: gw.status || null,
          photos: gw.photos || [],
        })),
        exportTime: bundle.exported_at,
        visit_id: v.visit_id,
      },
      devices: devices,
    };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  const CTKSchema = {
    SCHEMA_VERSION,
    EXPORT_TYPE,
    WORK_TYPES,
    workType,
    liveWorkTypes,
    isBWType,
    genId,
    createVisit,
    createWorkItem,
    emptyDataFor,
    validateVisit,
    buildBundleEnvelope,
    splitForGenerators,
    toLegacyBW,
    toLegacyInstall,
  };

  global.CTKSchema = CTKSchema;
  if (typeof module !== 'undefined' && module.exports) module.exports = CTKSchema;
})(typeof window !== 'undefined' ? window : globalThis);
