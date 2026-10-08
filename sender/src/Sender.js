// Outreach sender: menu, preview, TEST and LIVE sending with safety gates.
// Nothing is sent unless you click a Send menu item AND confirm it.

function onOpen() {
  const ui = ui_();
  if (!ui) return;
  ui.createMenu('Outreach')
    .addItem('1. Setup sheets', 'setupSender')
    .addItem('2. Preview (sends nothing)', 'previewOutreach')
    .addItem('3. Send TEST emails (own addresses only)', 'sendTestEmails')
    .addSeparator()
    .addItem('4. Send LIVE to dealers', 'sendLiveEmails')
    .addToUi();
}

function ui_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null;
  }
}

function requireUi_() {
  const ui = ui_();
  if (!ui) throw new Error('Run this from the sheet menu "Outreach" (it needs your confirmation).');
  return ui;
}

// ---------- setup ----------

function setupSender() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let rec = ss.getSheetByName(SENDER_CONFIG.SHEETS.RECIPIENTS);
  if (!rec) rec = ss.insertSheet(SENDER_CONFIG.SHEETS.RECIPIENTS, 0);
  if (rec.getLastRow() <= 1) { // never overwrite: this sheet holds the SENT history
    rec.clear();
    rec.getRange(1, 1, 1, RECIPIENT_COLUMNS.length).setValues([RECIPIENT_COLUMNS])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    rec.setFrozenRows(1);
    const rows = RECIPIENTS.map((r) => [
      true, r.email, r.dealers.map((d) => d.code).join(', '), r.dealers.map((d) => d.name).join(' | '), '', '', '', '',
    ]);
    rec.getRange(2, 1, rows.length, RECIPIENT_COLUMNS.length).setValues(rows);
    rec.getRange(2, 1, rows.length, 1).insertCheckboxes();
    rec.getRange(2, RECIPIENT_COLUMNS.indexOf('Sent at') + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    rec.autoResizeColumns(1, RECIPIENT_COLUMNS.length);
  }
  let log = ss.getSheetByName(SENDER_CONFIG.SHEETS.TEST_LOG);
  if (!log) log = ss.insertSheet(SENDER_CONFIG.SHEETS.TEST_LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, TEST_LOG_COLUMNS.length).setValues([TEST_LOG_COLUMNS]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  // Remove the empty default sheet of a new spreadsheet.
  const ours = Object.keys(SENDER_CONFIG.SHEETS).map((k) => SENDER_CONFIG.SHEETS[k]);
  ss.getSheets().forEach((sh) => {
    if (ours.indexOf(sh.getName()) === -1 && sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  notify_('Sheets ready. ' + RECIPIENTS.length + ' unique dealer addresses listed in "Recipients".\n' +
    'Untick "Send" for any dealer you do not want to email. Next: Preview.');
}

function notify_(msg) {
  console.log(msg);
  const ui = ui_();
  if (ui) ui.alert(msg);
}

// ---------- shared checks ----------

function recipientsSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SENDER_CONFIG.SHEETS.RECIPIENTS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('Run "1. Setup sheets" first.');
  const header = sheet.getRange(1, 1, 1, RECIPIENT_COLUMNS.length).getValues()[0].map(String);
  if (header.join('|') !== RECIPIENT_COLUMNS.join('|')) throw new Error('Recipients sheet columns were changed. Expected: ' + RECIPIENT_COLUMNS.join(', '));
  return sheet;
}

function readRecipients_(sheet) {
  const c = (n) => RECIPIENT_COLUMNS.indexOf(n);
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, RECIPIENT_COLUMNS.length).getValues().map((v, i) => ({
    row: i + 2,
    send: v[c('Send')] === true,
    email: String(v[c('Email')]).trim().toLowerCase(),
    dealers: String(v[c('Dealers')]),
    status: String(v[c('Status')]).trim(),
  })).filter((r) => r.email);
}

function recipientProblems_(rows) {
  const problems = [];
  const seen = {};
  rows.forEach((r) => {
    if (!isValidEmail_(r.email)) problems.push('Row ' + r.row + ': invalid email "' + r.email + '"');
    if (seen[r.email]) problems.push('Row ' + r.row + ': duplicate of row ' + seen[r.email] + ' (' + r.email + ')');
    seen[r.email] = seen[r.email] || r.row;
  });
  return problems;
}

// Account + attachment checks shared by TEST and LIVE.
function preflight_() {
  const account = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (account !== SENDER_CONFIG.EXPECTED_SENDER) {
    throw new Error('Wrong Google account: "' + account + '". Sending is only allowed from ' + SENDER_CONFIG.EXPECTED_SENDER + '.');
  }
  if (!attachmentIntact_()) throw new Error('Embedded PDF is corrupted (size/SHA-256 mismatch). Regenerate Attachment.js.');
  return { account, hash: contentHash_() };
}

function lastTest_() {
  const p = PropertiesService.getScriptProperties();
  return { hash: p.getProperty('LAST_TEST_HASH') || '', at: p.getProperty('LAST_TEST_AT') || '' };
}

function sendOne_(to) {
  const res = Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(buildMime_(to)) }, 'me');
  return res && res.id ? res.id : '';
}

function summaryLines_(account) {
  return [
    'From: ' + SENDER_CONFIG.FROM_NAME + ' <' + account + '>',
    'Subject: ' + EMAIL_SUBJECT,
    'Attachment: ' + SENDER_CONFIG.ATTACHMENT_NAME + ' (' + Math.round(ATTACHMENT_BYTES / 1024) + ' KB)',
  ];
}

// ---------- preview ----------

function previewOutreach() {
  const pf = preflight_();
  buildMime_(SENDER_CONFIG.TEST_RECIPIENTS[0]); // proves the message can be built
  const rows = readRecipients_(recipientsSheet_());
  const problems = recipientProblems_(rows);
  const pending = rows.filter((r) => r.send && r.status !== SEND_STATUS.SENT);
  const test = lastTest_();
  const tested = test.hash === pf.hash;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SENDER_CONFIG.SHEETS.PREVIEW);
  if (!sheet) sheet = ss.insertSheet(SENDER_CONFIG.SHEETS.PREVIEW);
  sheet.clear();
  const data = [
    ['Sending account', pf.account],
    ['From', SENDER_CONFIG.FROM_NAME + ' <' + pf.account + '>'],
    ['Subject', EMAIL_SUBJECT],
    ['Body', EMAIL_BODY],
    ['Attachment', SENDER_CONFIG.ATTACHMENT_NAME + ' – ' + ATTACHMENT_BYTES + ' bytes, SHA-256 ' + ATTACHMENT_SHA256 + ' (verified)'],
    ['Content hash', pf.hash],
    ['TEST status', tested ? 'Tested ' + test.at + ' – LIVE unlocked for this exact content' : 'NOT tested with this content – LIVE is locked'],
    ['Recipient problems', problems.length ? problems.join('\n') : 'none'],
    ['LIVE would send to', pending.length + ' addresses (one separate email each)'],
  ];
  pending.forEach((r, i) => data.push([String(i + 1), r.email + '  –  ' + r.dealers + (r.status ? '  [' + r.status + ']' : '')]));
  sheet.getRange(1, 1, data.length, 2).setValues(data).setVerticalAlignment('top').setWrap(true);
  sheet.getRange(1, 1, data.length, 1).setFontWeight('bold');
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 800);
  ss.setActiveSheet(sheet);

  notify_(['Preview written to the "Preview" sheet. Nothing was sent.', ''].concat(summaryLines_(pf.account), [
    'TEST: ' + (tested ? 'done (' + test.at + ')' : 'not done for this content'),
    'LIVE would send: ' + pending.length + ' emails',
    problems.length ? 'Recipient problems: ' + problems.length + ' (see Preview)' : '',
  ]).filter((l) => l !== null).join('\n'));
}

// ---------- TEST ----------

function sendTestEmails() {
  const ui = requireUi_();
  const pf = preflight_();
  const to = SENDER_CONFIG.TEST_RECIPIENTS.slice();
  const ok = ui.alert('Send TEST emails?',
    summaryLines_(pf.account).concat(['', 'To (' + to.length + ' separate emails, your own addresses only):'], to).join('\n'),
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another send is already running.');
  try {
    const log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SENDER_CONFIG.SHEETS.TEST_LOG);
    if (!log) throw new Error('Run "1. Setup sheets" first.');
    let sent = 0;
    for (const addr of to) {
      if (SENDER_CONFIG.TEST_RECIPIENTS.indexOf(addr) === -1) throw new Error('Not a test address: ' + addr);
      try {
        const id = sendOne_(addr);
        log.appendRow([new Date(), addr, pf.hash, id, 'SENT']);
        sent++;
      } catch (e) {
        log.appendRow([new Date(), addr, pf.hash, '', 'FAILED: ' + (e && e.message ? e.message : e)]);
        SpreadsheetApp.flush();
        throw new Error('TEST send failed for ' + addr + ': ' + (e && e.message ? e.message : e) + '. LIVE stays locked.');
      }
    }
    const at = Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm');
    PropertiesService.getScriptProperties().setProperties({ LAST_TEST_HASH: pf.hash, LAST_TEST_AT: at });
    notify_('Sent ' + sent + ' TEST emails.\n\nCheck every inbox (and spam): subject, accents, line breaks, attachment opens.\n' +
      'LIVE is now unlocked for exactly this content. Any change to subject, body or PDF locks it again.');
  } finally {
    lock.releaseLock();
  }
}

// ---------- LIVE ----------

function sendLiveEmails() {
  const ui = requireUi_();
  const pf = preflight_();
  const test = lastTest_();
  if (test.hash !== pf.hash) {
    throw new Error('LIVE is locked: send TEST emails with the current content first (subject, body or PDF changed since the last test, or no test yet).');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another send is already running.');
  try {
    const sheet = recipientsSheet_();
    const rows = readRecipients_(sheet);
    const stuck = rows.filter((r) => r.status === SEND_STATUS.SENDING);
    if (stuck.length) {
      throw new Error('Unknown state for: ' + stuck.map((r) => r.email).join(', ') +
        '. A previous run stopped mid-send. Check your Gmail "Sent" folder: set Status to SENT if it went out, or clear it to retry.');
    }
    const problems = recipientProblems_(rows);
    if (problems.length) throw new Error('Fix the Recipients sheet first:\n' + problems.join('\n'));
    const pending = rows.filter((r) => r.send && r.status !== SEND_STATUS.SENT);
    if (!pending.length) return notify_('Nothing to send: every ticked recipient is already SENT.');

    const phrase = 'SEND ' + pending.length;
    const answer = ui.prompt('Send LIVE emails to dealers?', summaryLines_(pf.account).concat([
      '',
      'Recipients not yet sent: ' + pending.length + ' (one separate email each, nobody sees the others).',
      'One click sends for up to ~4.5 minutes, then click again to continue.',
      '',
      'Type exactly:  ' + phrase,
    ]).join('\n'), ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK || answer.getResponseText().trim() !== phrase) {
      return notify_('Cancelled. Nothing was sent.');
    }

    const col = (n) => RECIPIENT_COLUMNS.indexOf(n) + 1;
    const setStatus = (r, status, sentAt, id, error) => {
      sheet.getRange(r.row, col('Status'), 1, 4).setValues([[status, sentAt, id, error]]);
      SpreadsheetApp.flush();
    };
    const start = Date.now();
    let sent = 0;
    let failure = '';
    for (let i = 0; i < pending.length; i++) {
      if (Date.now() - start > SENDER_CONFIG.RUN_BUDGET_MS) break;
      const r = pending[i];
      setStatus(r, SEND_STATUS.SENDING, '', '', ''); // stays SENDING only if the run dies mid-send
      try {
        const id = sendOne_(r.email);
        setStatus(r, SEND_STATUS.SENT, new Date(), id, '');
        sent++;
      } catch (e) {
        failure = r.email + ': ' + (e && e.message ? e.message : e);
        setStatus(r, SEND_STATUS.FAILED, '', '', failure);
        break; // stop on the first error (quota, auth, ...) instead of failing the rest
      }
      if (i < pending.length - 1) {
        Utilities.sleep(SENDER_CONFIG.MIN_DELAY_MS + Math.floor(Math.random() * (SENDER_CONFIG.MAX_DELAY_MS - SENDER_CONFIG.MIN_DELAY_MS)));
      }
    }
    const remaining = pending.length - sent;
    notify_([
      'Sent now: ' + sent,
      'Remaining: ' + remaining,
      failure ? 'Stopped on error: ' + failure : '',
      remaining && !failure ? 'Click "4. Send LIVE to dealers" again to continue.' : '',
      !remaining ? 'All done.' : '',
    ].filter(Boolean).join('\n'));
  } finally {
    lock.releaseLock();
  }
}
