// Offline tests for sender/. Gmail is MOCKED: nothing is sent anywhere. Run: npm test
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'sender', 'src');
const OUT = path.join(require('os').tmpdir(), 'suzuki-sender-test-out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const signed = (buf) => Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
const unsigned = (arr) => Buffer.from(Uint8Array.from(arr, (x) => x & 255));

// ---- mock sheets ----
function Sheet(name) {
  this.name = name; this.data = [];
}
Sheet.prototype = {
  getName() { return this.name; },
  getLastRow() { return this.data.length; },
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); },
  clear() { this.data = []; return this; },
  appendRow(r) { this.data.push(r.slice()); return this; },
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const range = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((sh.data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); }
        return out;
      },
      setValues(v) {
        if (v.length !== nr || v[0].length !== nc) throw new Error(`setValues size mismatch ${v.length}x${v[0].length} vs ${nr}x${nc}`);
        v.forEach((row, i) => { sh.data[r - 1 + i] = sh.data[r - 1 + i] || []; row.forEach((x, j) => { sh.data[r - 1 + i][c - 1 + j] = x; }); });
        return proxy;
      },
    };
    const proxy = new Proxy(range, { get: (t, p) => t[p] || (() => proxy) });
    return proxy;
  },
};
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
for (const m of ['setFrozenRows', 'autoResizeColumns', 'setColumnWidth']) Sheet.prototype[m] = function () { return this; };

let ss;
function newSpreadsheet() {
  const sheets = [new Sheet('Sheet1')];
  ss = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n, idx) => { const s = new Sheet(n); idx === 0 ? sheets.unshift(s) : sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
    setActiveSheet: () => {},
  };
}

// ---- scripted UI ----
const ui = {
  next: [], alerts: [],
  Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
  ButtonSet: { YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
  alert(title, msg) { this.alerts.push(msg || title); return msg ? this.next.shift() : 'OK'; },
  prompt(title, msg) { this.alerts.push(msg); const a = this.next.shift(); return { getSelectedButton: () => a.button, getResponseText: () => a.text }; },
  createMenu() { return noop; },
};
let uiAvailable = true;

// ---- mocks ----
let account = 'doboshuni@gmail.com';
let sent = [];
let failAt = -1;
let fakeNow = 0;
const props = {};
const ctx = {
  console: { log: () => {}, error: console.error },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => { if (!uiAvailable) throw new Error('no ui'); return ui; }, flush: () => {} },
  Session: { getEffectiveUser: () => ({ getEmail: () => account }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => props[k] ?? null,
    setProperties: (o) => Object.assign(props, o),
  }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Gmail: { Users: { Messages: { send: (res, user) => {
    if (user !== 'me' || Object.keys(res).join() !== 'raw') throw new Error('bad send call');
    if (sent.length === failAt) throw new Error('Mock failure');
    const mime = Buffer.from(res.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    const to = /^To: (.*)$/m.exec(mime)[1];
    sent.push(to);
    fs.writeFileSync(path.join(OUT, String(sent.length).padStart(3, '0') + '.eml'), mime, 'latin1');
    return { id: 'msg' + sent.length, threadId: 't' + sent.length };
  } } } },
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'sha256' },
    base64Encode: (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : unsigned(x)).toString('base64'),
    base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => signed(Buffer.from(s, 'base64')),
    computeDigest: (alg, x) => signed(crypto.createHash(alg).update(typeof x === 'string' ? Buffer.from(x, 'utf8') : unsigned(x)).digest()),
    getUuid: () => crypto.randomUUID(),
    formatDate: (d) => d.toISOString().slice(0, 16),
    sleep: (ms) => { fakeNow += ms; },
  },
};
vm.createContext(ctx);
for (const f of ['Config', 'Template', 'Attachment', 'Recipients', 'Mime', 'Sender']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
}
vm.runInContext('Date.now = () => globalThis.__now()', ctx);
ctx.__now = () => fakeNow;
// each mock send "takes" 1.5s
const realSend = ctx.Gmail.Users.Messages.send;
ctx.Gmail.Users.Messages.send = (...a) => { fakeNow += 1500; return realSend(...a); };

// ---- test runner ----
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra));
  if (!cond) failures++;
}
function run(fn, answers = []) {
  ui.next = answers.slice(); ui.alerts = [];
  try { vm.runInContext(fn + '()', ctx); return { ok: true, msg: ui.alerts.join('\n---\n') }; } catch (e) { return { ok: false, msg: e.message }; }
}
const recRows = () => ss.getSheetByName('Recipients').data.slice(1);
const C = (n) => vm.runInContext('RECIPIENT_COLUMNS', ctx).indexOf(n);
const TEST = vm.runInContext('SENDER_CONFIG.TEST_RECIPIENTS', ctx);

newSpreadsheet();
let r = run('setupSender');
check('setup creates 73 recipients, all ticked', recRows().length === 73 && recRows().every((x) => x[0] === true), r.msg);
check('setup removes empty default sheet', !ss.getSheetByName('Sheet1'));
check('setup never overwrites existing recipients', (() => { ss.getSheetByName('Recipients').data[1][C('Status')] = 'X'; run('setupSender'); const ok = ss.getSheetByName('Recipients').data[1][C('Status')] === 'X'; ss.getSheetByName('Recipients').data[1][C('Status')] = ''; return ok; })());

r = run('previewOutreach');
check('preview sends nothing, says not tested', r.ok && sent.length === 0 && /not done/.test(r.msg), r.msg);

r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 73' }]);
check('LIVE refused before any TEST', !r.ok && /LIVE is locked/.test(r.msg) && sent.length === 0, r.msg);

uiAvailable = false;
r = run('sendTestEmails');
check('TEST refused without UI (editor run)', !r.ok && sent.length === 0, r.msg);
r = run('sendLiveEmails');
check('LIVE refused without UI (editor run)', !r.ok && sent.length === 0, r.msg);
uiAvailable = true;

r = run('sendTestEmails', ['NO']);
check('TEST cancelled with NO sends nothing', r.ok && sent.length === 0, r.msg);

account = 'someone.else@gmail.com';
r = run('sendTestEmails', ['YES']);
check('TEST refused from wrong account', !r.ok && /Wrong Google account/.test(r.msg) && sent.length === 0, r.msg);
account = 'doboshuni@gmail.com';

r = run('sendTestEmails', ['YES']);
check('TEST sends exactly to the 5 test addresses', r.ok && JSON.stringify(sent) === JSON.stringify(TEST), JSON.stringify(sent) + r.msg);
check('TEST log has 5 SENT rows', ss.getSheetByName('Test log').data.slice(1).filter((x) => x[4] === 'SENT').length === 5);
check('TEST unlocks LIVE (hash stored)', props.LAST_TEST_HASH === vm.runInContext('contentHash_()', ctx));
const testCount = sent.length;

r = run('previewOutreach');
check('preview after test: tested, would send 73', /TEST: done/.test(r.msg) && /would send: 73/.test(r.msg), r.msg);

r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 72' }]);
check('LIVE wrong phrase -> cancelled, nothing sent', r.ok && sent.length === testCount && /Cancelled/.test(r.msg), r.msg);
r = run('sendLiveEmails', [{ button: 'CANCEL', text: 'SEND 73' }]);
check('LIVE Cancel button -> nothing sent', r.ok && sent.length === testCount, r.msg);

// content change after test locks LIVE
vm.runInContext('globalThis.__n = SENDER_CONFIG.ATTACHMENT_NAME; SENDER_CONFIG.ATTACHMENT_NAME = "other.pdf"', ctx);
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 73' }]);
check('LIVE locked after content change', !r.ok && /LIVE is locked/.test(r.msg) && sent.length === testCount, r.msg);
vm.runInContext('SENDER_CONFIG.ATTACHMENT_NAME = globalThis.__n', ctx);

// bad recipient data
const rec = ss.getSheetByName('Recipients');
const saved = JSON.stringify(rec.data);
rec.data[5][C('Email')] = 'a@b.hu, evil@x.hu';
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 73' }]);
check('LIVE refused: injected multi-address cell', !r.ok && /invalid email/.test(r.msg) && sent.length === testCount, r.msg);
rec.data = JSON.parse(saved);
rec.data[6][C('Email')] = rec.data[2][C('Email')].toUpperCase();
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 73' }]);
check('LIVE refused: duplicate address (case-insensitive)', !r.ok && /duplicate/.test(r.msg) && sent.length === testCount, r.msg);
rec.data = JSON.parse(saved);
rec.data[3][C('Status')] = 'SENDING';
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 73' }]);
check('LIVE refused: row stuck in SENDING', !r.ok && /Unknown state/.test(r.msg) && sent.length === testCount, r.msg);
rec.data = JSON.parse(saved);

// untick 3 dealers
[0, 10, 20].forEach((i) => { rec.data[1 + i][C('Send')] = false; });
const unticked = [0, 10, 20].map((i) => rec.data[1 + i][C('Email')]);

// LIVE run 1: budget limited
fakeNow = 0;
failAt = testCount + 12; // 13th live email fails
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 70' }]);
check('LIVE run stops at first error, marks FAILED', r.ok && sent.length === testCount + 12 && /Stopped on error/.test(r.msg) &&
  recRows().filter((x) => x[C('Status')] === 'FAILED').length === 1, r.msg);
failAt = -1;

let before = sent.length;
fakeNow = 0;
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 58' }]);
const firstBatch = sent.length - before;
check('LIVE run respects 4.5 min budget (partial batch, continue msg)', r.ok && firstBatch > 20 && firstBatch < 58 && /again to continue/.test(r.msg), firstBatch + ' ' + r.msg);
check('FAILED row retried first in next run', sent[before] === recRows().find((x) => x[C('Message ID')] === 'msg' + (before + 1))[C('Email')]);

const remaining = 58 - firstBatch;
fakeNow = 0;
r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND ' + remaining }]);
check('LIVE final run finishes', r.ok && /All done/.test(r.msg), r.msg);

r = run('sendLiveEmails', [{ button: 'OK', text: 'SEND 0' }]);
check('LIVE afterwards: nothing to send', r.ok && /Nothing to send/.test(r.msg));

const live = sent.slice(testCount);
const ticked = recRows().filter((x) => x[C('Send')] === true).map((x) => x[C('Email')]);
check('every ticked dealer received exactly one email', live.length === 70 && new Set(live).size === 70 && ticked.every((e) => live.includes(e)), live.length + ' ' + new Set(live).size);
check('unticked dealers received nothing', unticked.every((e) => !live.includes(e)));
check('no test address in live sends', live.every((e) => !TEST.includes(e)));
check('all ticked rows SENT with message id + date', recRows().filter((x) => x[C('Send')]).every((x) => x[C('Status')] === 'SENT' && /^msg\d+$/.test(x[C('Message ID')]) && Object.prototype.toString.call(x[C('Sent at')]) === '[object Date]'));
check('each email has a single To address', fs.readdirSync(OUT).every((f) => { const m = fs.readFileSync(path.join(OUT, f), 'latin1'); return (m.match(/^To: /mg) || []).length === 1 && !/^(Cc|Bcc):/mi.test(m); }));

console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}; ${sent.length} mock emails written to ${OUT}`);
process.exitCode = failures ? 1 : 0;
