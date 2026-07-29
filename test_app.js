/**
 * Integration tests — drives the real index.html in jsdom.
 * Run: node test_app.js
 */
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) passed++;
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); }
}
function eq(name, a, e) {
  ok(name, JSON.stringify(a) === JSON.stringify(e),
     'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(e));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) console.error('JSDOM', e.message); });

  const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), {
    runScripts: 'dangerously',
    resources: undefined,
    url: 'https://bliddell92.github.io/citritek-field-app/',
    virtualConsole: vc,
    beforeParse(win) {
      // Serve the reference JSON files from disk
      win.fetch = async (url) => {
        const file = String(url).split('?')[0].split('/').pop();
        const p = path.join(__dirname, file);
        if (!fs.existsSync(p)) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
      };
      win.indexedDB = global.indexedDB;
      win.IDBKeyRange = global.IDBKeyRange;
      win.confirm = () => true;
      win.scrollTo = () => {};
    },
  });

  const win = dom.window;
  const doc = win.document;

  // Load the two module scripts manually (jsdom won't fetch local <script src>)
  win.eval(fs.readFileSync('ctk_schema.js', 'utf8'));
  win.eval(fs.readFileSync('ctk_storage.js', 'utf8'));

  // Re-run the inline app script now that its dependencies exist
  const html = fs.readFileSync('index.html', 'utf8');
  const appScript = html.match(/<script>\n'use strict';([\s\S]*?)<\/script>/)[1];
  win.eval(appScript);

  await sleep(300);   // let boot() finish

  const screen = () => doc.querySelector('.screen.active').dataset.screen;

  // ═══ BOOT ═════════════════════════════════════════════════
  console.log('\n── Boot ──');
  eq('starts on home', screen(), 'home');
  ok('reference data loaded', win.CTKStorage != null);
  eq('offline indicator hidden', doc.getElementById('staleIndicator').style.display, 'none');
  ok('empty state shown', /No completed visits|No visits/.test(doc.getElementById('recentList').textContent));

  // ═══ WORK TYPE PICKER ═════════════════════════════════════
  console.log('── Work type picker ──');
  win.goWorkType();
  eq('navigates to work type', screen(), 'workType');

  const cards = doc.querySelectorAll('#workTypeList .card');
  ok('work types rendered', cards.length === 8, 'found ' + cards.length);
  const plannedCards = doc.querySelectorAll('#workTypeList .card.planned');
  eq('three planned types greyed out', plannedCards.length, 3);
  ok('planned cards are not clickable', !plannedCards[0].getAttribute('onclick'));

  const groups = [...doc.querySelectorAll('.wt-group')].map((g) => g.textContent);
  eq('grouped correctly', groups, ['General', 'Bristol Water', 'Coming later']);
  ok('installation appears first (General)', cards[0].textContent.includes('Device Installation'));

  // ═══ TYPED FLOW (installation) ════════════════════════════
  console.log('── Typed flow: installation ──');
  await win.selectWorkType('installation');
  await sleep(50);
  eq('typed type skips site picker', screen(), 'setup');

  eq('client field shown', doc.getElementById('setupClientField').style.display, '');
  eq('client-locked hidden', doc.getElementById('setupClientLocked').style.display, 'none');
  eq('site field shown', doc.getElementById('setupSiteField').style.display, '');
  eq('address field shown', doc.getElementById('setupAddressField').style.display, '');
  ok('date defaults to today', doc.getElementById('fDate').value === new Date().toISOString().slice(0, 10));
  eq('heading uses the work type label', doc.getElementById('setupHeading').textContent, 'Device Installation');

  // Validation
  await win.startVisit();
  await sleep(30);
  eq('blocked with empty fields', screen(), 'setup');
  ok('validation toast shown', /client/i.test(doc.querySelector('.toast').textContent));

  doc.getElementById('fClient').value = 'Dishoom';
  doc.getElementById('fSite').value = 'Battersea (D10)';
  doc.getElementById('fAddress').value = '42 Electric Blvd, Nine Elms';
  doc.getElementById('fDate').value = '2026-08-03';
  await win.startVisit();
  await sleep(50);
  eq('blocked without technician', screen(), 'setup');

  doc.getElementById('fTech').value = 'Ben Liddell';
  await win.startVisit();
  await sleep(100);
  eq('lands on visit screen', screen(), 'visit');

  let visits = await win.CTKStorage.getAllVisits();
  eq('one visit stored', visits.length, 1);
  eq('client saved', visits[0].client, 'Dishoom');
  eq('site saved', visits[0].site, 'Battersea (D10)');
  eq('address saved', visits[0].address, '42 Electric Blvd, Nine Elms');
  eq('no site_ref for typed job', visits[0].site_ref, null);
  eq('one work item', visits[0].work_items.length, 1);
  eq('work item type', visits[0].work_items[0].type, 'installation');
  ok('first-ever client flagged as new', visits[0].meta.client_is_new === true);
  eq('visit passes validation', win.CTKSchema.validateVisit(visits[0]), []);

  ok('visit header shows the site', doc.getElementById('visitHeader').textContent.includes('Battersea'));
  ok('new-client flag visible', doc.querySelector('.newflag') !== null);
  eq('one work item row', doc.querySelectorAll('#workItemList .wi-row').length, 1);

  // ═══ SECOND WORK ITEM AT SAME SITE ════════════════════════
  console.log('── Second work item, same visit ──');
  const visitId = visits[0].visit_id;
  win.goAddWorkItem();
  eq('goes to work type picker', screen(), 'workType');
  await win.selectWorkType('bw_quarterly');
  await sleep(100);
  eq('returns to visit, no setup screen', screen(), 'visit');

  visits = await win.CTKStorage.getAllVisits();
  eq('still one visit', visits.length, 1);
  eq('now two work items', visits[0].work_items.length, 2);
  eq('envelope unchanged', visits[0].site, 'Battersea (D10)');
  eq('two rows rendered', doc.querySelectorAll('#workItemList .wi-row').length, 2);

  // Remove it again
  await win.removeWorkItem(visits[0].work_items[1].work_item_id);
  await sleep(80);
  visits = await win.CTKStorage.getAllVisits();
  eq('work item removed', visits[0].work_items.length, 1);
  eq('visit survives removal', visits.length, 1);

  // ═══ REFERENCE FLOW (Bristol Water) ═══════════════════════
  console.log('── Reference flow: Bristol Water ──');
  win.goHome();
  await sleep(80);
  win.goWorkType();
  await win.selectWorkType('bw_six_monthly');
  await sleep(200);
  eq('BW type goes to site picker', screen(), 'sitePicker');

  const siteCards = doc.querySelectorAll('#siteList .card');
  eq('all 48 sites listed', siteCards.length, 48);
  ok('lede names the client', doc.getElementById('sitePickerLede').textContent.includes('Bristol Water'));

  doc.getElementById('siteSearch').value = 'alderley';
  win.filterSites();
  const visible = [...siteCards].filter((c) => c.style.display !== 'none');
  eq('search filters to one site', visible.length, 1);
  ok('correct site matched', visible[0].textContent.includes('Alderley'));

  doc.getElementById('siteSearch').value = 'GL12';
  win.filterSites();
  ok('postcode search works', [...siteCards].filter((c) => c.style.display !== 'none').length >= 1);

  await win.selectSite('Alderley TW');
  await sleep(80);
  eq('goes to setup', screen(), 'setup');
  eq('client is locked for BW', doc.getElementById('setupClientLocked').style.display, '');
  eq('client input hidden', doc.getElementById('setupClientField').style.display, 'none');
  eq('locked client is Bristol Water', doc.getElementById('lockedClient').textContent, 'Bristol Water');
  eq('site is locked', doc.getElementById('setupSiteLocked').style.display, '');
  eq('locked site correct', doc.getElementById('lockedSite').textContent, 'Alderley TW');
  eq('address hidden for BW', doc.getElementById('setupAddressField').style.display, 'none');

  doc.getElementById('fDate').value = '2026-08-04';
  doc.getElementById('fTech').value = 'Tom Wharton';
  await win.startVisit();
  await sleep(120);
  eq('BW visit created', screen(), 'visit');

  visits = await win.CTKStorage.getAllVisits();
  eq('two visits now', visits.length, 2);
  const bwVisit = visits.find((v) => v.client === 'Bristol Water');
  eq('site_ref set for BW', bwVisit.site_ref, 'Alderley TW');
  eq('BW visit validates', win.CTKSchema.validateVisit(bwVisit), []);
  ok('BW client not flagged new', bwVisit.meta.client_is_new === false);

  // ═══ SUGGESTIONS ══════════════════════════════════════════
  console.log('── Typing suggestions ──');
  win.goHome();
  await sleep(60);
  win.goWorkType();
  await win.selectWorkType('installation');
  await sleep(80);
  const clientOpts = [...doc.querySelectorAll('#dlClient option')].map((o) => o.value);
  ok('Dishoom now suggested', clientOpts.includes('Dishoom'));
  const siteOpts = [...doc.querySelectorAll('#dlSite option')].map((o) => o.value);
  ok('site suggested too', siteOpts.includes('Battersea (D10)'));
  ok('BW site not in typed suggestions', !siteOpts.includes('Alderley TW'));

  doc.getElementById('fClient').value = 'Dishoom';
  doc.getElementById('fSite').value = 'Shoreditch (D2)';
  doc.getElementById('fDate').value = '2026-08-05';
  doc.getElementById('fTech').value = 'Ben Liddell';
  await win.startVisit();
  await sleep(120);
  visits = await win.CTKStorage.getAllVisits();
  const second = visits.find((v) => v.site === 'Shoreditch (D2)');
  ok('known client not flagged new', second.meta.client_is_new === false);

  // ═══ HOME LIST ════════════════════════════════════════════
  console.log('── Home screen ──');
  win.goHome();
  await sleep(100);
  eq('back on home', screen(), 'home');
  ok('in-progress banner shown', doc.querySelector('.resume') !== null);
  ok('banner names a site', doc.querySelector('.resume-site').textContent.length > 0);

  // ═══ NAVIGATION ═══════════════════════════════════════════
  console.log('── Navigation ──');
  eq('back button hidden on home', doc.getElementById('backBtn').style.display, 'none');
  win.goWorkType();
  eq('back button shown off-home', doc.getElementById('backBtn').style.display, 'flex');
  win.goBack();
  eq('back returns home', screen(), 'home');

  // ═══ ISOLATION FROM THE LIVE BW APP ═══════════════════════
  console.log('── Isolation from live BW app ──');
  eq('uses its own database', win.CTKStorage.DB_NAME, 'ctk_field_app');
  const dbs = (await (global.indexedDB.databases ? global.indexedDB.databases() : [])) || [];
  ok('bw_field_app never opened', !dbs.some((d) => d.name === 'bw_field_app'),
     'open DBs: ' + dbs.map((d) => d.name).join(','));

  // ═══ RESULT ═══════════════════════════════════════════════
  console.log('\n' + '─'.repeat(52));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('─'.repeat(52));
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
  console.log('─'.repeat(52) + '\n');
  win.close();
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
