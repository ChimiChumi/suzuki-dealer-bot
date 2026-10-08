// Offline tests for tracker/: Gmail, Sheets and Gemini are MOCKED (no network). Run: npm test
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const SRC = path.join(__dirname, '..', 'tracker', 'src');
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const part = (t) => ({ mimeType: 'text/plain', filename: '', headers: [], body: { data: b64url(t), size: t.length } });
// ids: hex, growing over time, deliberately different lengths
const MSG = {
  '19a0000000000001': { from: 'info@suzukigero.hu', date: '2026-10-09T08:00:00Z', a: { availability: 'IN_STOCK', configMatch: 'EXACT', hasOffer: true, finalTotalGross: 11340000, summary: 'Offer 11.34M' } },
  '19a0000000000002': { from: 'suzukiperger@gmail.com', date: '2026-10-09T09:00:00Z', a: { availability: 'NOT_AVAILABLE', configMatch: 'UNCLEAR', summary: 'Not in stock' } },
  '19a0000000000003': { from: 'info@suzukigero.hu', date: '2026-10-10T08:00:00Z', a: { availability: 'NEEDS_ACTION', configMatch: 'UNCLEAR', summary: 'Did you get our offer? Please call.' } },
  '19a0000000000004': { from: 'suzukiperger@gmail.com', date: '2026-10-10T09:00:00Z', a: { availability: 'NEEDS_ACTION', configMatch: 'UNCLEAR', summary: 'Call us' } },
  '19a00000000000a5': { from: 'suzukiperger@gmail.com', date: '2026-10-11T09:00:00Z', a: { availability: 'IN_STOCK', configMatch: 'EXACT', hasOffer: true, finalTotalGross: 11200000, summary: 'Now in stock 11.2M' } },
  '19a00000000000a6': { from: 'kisvardasuzuki@gmail.com', date: '2026-10-11T10:00:00Z', a: { availability: 'NEEDS_ACTION', configMatch: 'UNCLEAR', summary: 'Call us first' } },
};
const base = { isRelevant: true, dealerCode: '', configNotes: '', estimatedDelivery: '', hasOffer: false, paidAccessoriesTotal: 0, paidAccessories: '', finalTotalGross: 0, includesWinterTires: false, freebies: '', freebiesValue: 0, offerValidUntil: '' };
const queries = [];
const Gmail = { Users: {
  getProfile: () => ({ emailAddress: 'test@gmail.com' }),
  Messages: {
    // each query returns a shuffled subset; union must be complete and sorted
    list: (u, o) => { queries.push(o.q); const ids = Object.keys(MSG); return { messages: (queries.length % 2 ? ids : ids.slice().reverse()).map((id) => ({ id })) }; },
    get: (u, id) => ({ id, labelIds: ['INBOX'], threadId: 't' + id, internalDate: String(Date.parse(MSG[id].date)), snippet: '', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: MSG[id].from }, { name: 'Subject', value: 'Re: x' }], parts: [part('hi')] } }),
  },
  Threads: { get: () => ({ messages: [] }) },
} };
function makeSheet(name) {
  const data = [];
  const sh = { data, getName: () => name, getLastRow: () => data.length, getLastColumn: () => Math.max(0, ...data.map((r) => r.length)), clear: () => { data.length = 0; }, appendRow: (r) => data.push(r.slice()),
    getRange: (r, c, nr = 1, nc = 1) => { const rng = new Proxy({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { data[r - 1 + i] = data[r - 1 + i] || []; data[r - 1 + i][c - 1 + j] = x; })); return rng; },
      setValue: (x) => { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = x; return rng; } }, { get: (t, p) => t[p] || (() => rng) }); return rng; } };
  return new Proxy(sh, { get: (t, p) => (p in t ? t[p] : () => undefined) });
}
const sheets = {};
const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });
const ctx = { console, Gmail,
  SpreadsheetApp: new Proxy({ getActiveSpreadsheet: () => ss, getUi: () => ({ alert: () => {} }) }, { get: (t, p) => t[p] || chain() }),
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'KEY' }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Utilities: { base64DecodeWebSafe: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), base64Encode: (b) => Buffer.from(b).toString('base64'),
    newBlob: (b) => ({ getDataAsString: () => Buffer.from(b).toString('utf8') }), formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
};
vm.createContext(ctx);
for (const f of ['Config.js', 'Dealers.js', 'Mail.js', 'Gemini.js', 'Main.js', 'Setup.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
const order = [];
ctx.__analyze = (key, email, cands) => { order.push(email.id); const a = Object.assign({}, base, MSG[email.id].a); a.dealerCode = cands[0].code; return a; };
vm.runInContext('__realAnalyze = analyzeEmail_; analyzeEmail_ = (k, e, c) => __analyze(k, e, c); setupDealersSheet_(SpreadsheetApp.getActiveSpreadsheet()); setupLogSheet_(SpreadsheetApp.getActiveSpreadsheet());', ctx);

// 1. query chunks
const qs = vm.runInContext('buildSearchQueries_()', ctx);
const allTerms = qs.flatMap((q) => q.match(/(from:\S+|subject:"[^"]+")/g));
assert(qs.length >= 4, 'split into several queries');
qs.forEach((q) => { assert(q.length < 900, 'query short: ' + q.length); assert(q.startsWith('-in:trash -in:sent after:2026/10/01 {') && q.endsWith('}')); });
assert(allTerms.includes('subject:"S-Cross GLX Urban Black"') && allTerms.includes('from:doboshuni@icloud.com'));
assert.strictEqual(new Set(allTerms).size, allTerms.length, 'no duplicate terms');
console.log('PASS queries:', qs.length, 'max len', Math.max(...qs.map((q) => q.length)), 'terms', allTerms.length);

// 2. time budget 0 → processes nothing
vm.runInContext('CONFIG.RUN_BUDGET_MS = -1', ctx);
let s = vm.runInContext('processInbox()', ctx);
assert.strictEqual(s.processed, 0); assert.strictEqual(s.pending, 6);
console.log('PASS time budget stops run');
vm.runInContext('CONFIG.RUN_BUDGET_MS = 270000', ctx);

// 3. full run, oldest first
s = vm.runInContext('processInbox()', ctx);
assert.strictEqual(s.processed, 6);
assert.deepStrictEqual(order, Object.keys(MSG), 'oldest first despite mixed id lengths');
console.log('PASS union + oldest-first order');

const H = sheets.Dealers.data[0];
const row = (code) => { const r = sheets.Dealers.data.find((x) => x[0] === code); const o = {}; H.forEach((h, i) => (o[h] = r[i])); return o; };
const codeOf = (email) => vm.runInContext(`DEALERS.find(d => d.email === '${email}').code`, ctx);
const gero = row(codeOf('info@suzukigero.hu')), perger = row(codeOf('suzukiperger@gmail.com')), kis = row(codeOf('kisvardasuzuki@gmail.com'));
assert.strictEqual(gero.Status, 'In stock'); assert.strictEqual(gero['Final total (Ft)'], 11340000);
assert(/Offer 11.34M\nFollow-up 2026-10-10: Did you get our offer/.test(gero.Summary), gero.Summary);
assert.strictEqual(gero['Last reply'].toISOString(), '2026-10-10T08:00:00.000Z');
console.log('PASS In stock kept after follow-up; summary appended');
assert.strictEqual(perger.Status, 'In stock'); assert.strictEqual(perger['Final total (Ft)'], 11200000);
console.log('PASS Not available → follow-up kept → later In stock upgrades');
assert.strictEqual(kis.Status, 'Needs action');
console.log('PASS Waiting → Needs action still applies');
assert.strictEqual(perger.Rank, 1); assert.strictEqual(gero.Rank, 2);
const results = sheets.Log.data.slice(1).map((r) => r[6]);
assert.deepStrictEqual(results, ['In stock', 'Not available', 'FOLLOW-UP (kept In stock)', 'FOLLOW-UP (kept Not available)', 'In stock', 'Needs action']);
console.log('PASS log results', JSON.stringify(results));

// 4. second run: nothing new
s = vm.runInContext('processInbox()', ctx);
assert.strictEqual(s.pending, 0);
console.log('PASS no reprocessing');

// 5. Gemini 402 (no prepaid credits) / 429: run pauses, email stays queued, no ERROR row
for (const code of [402, 429]) {
  const id = '19a00000000000b' + code;
  MSG[id] = { from: 'info@suzukigero.hu', date: '2026-10-12T08:00:00Z' };
  const logRows = sheets.Log.data.length;
  ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => code, getContentText: () => '{"error":{"code":' + code + ',"message":"Your prepayment credits are depleted."}}' }) };
  vm.runInContext('analyzeEmail_ = __realAnalyze', ctx);
  s = vm.runInContext('processInbox()', ctx);
  assert.strictEqual(s.rateLimited, true); assert.strictEqual(s.errors, 0); assert.strictEqual(s.processed, 0);
  assert.strictEqual(sheets.Log.data.length, logRows, 'no Log row written');
  assert(/402|429/.test(s.lastError));
  s = vm.runInContext('processInbox()', ctx);
  assert.strictEqual(s.pending, 1, 'still queued');
  delete MSG[id];
  console.log('PASS Gemini ' + code + ' pauses run, email stays queued');
}
console.log('ALL PASSED');
