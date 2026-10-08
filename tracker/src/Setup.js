// Spreadsheet menu, one-time setup, API key and trigger management.

function onOpen() {
  const ui = ui_();
  if (!ui) {
    console.log('onOpen runs automatically when the sheet is opened. Reload the spreadsheet to see the "Suzuki Bot" menu.');
    return;
  }
  ui
    .createMenu('Suzuki Bot')
    .addItem('1. Setup sheets', 'setup')
    .addItem('2. Set Gemini API key', 'promptApiKey')
    .addItem('3. Start automation', 'startAutomation')
    .addSeparator()
    .addItem('Run now', 'runNow')
    .addItem('Retry failed emails', 'retryFailed')
    .addItem('Recompute ranking', 'recomputeRanking')
    .addItem('Stop automation', 'stopAutomation')
    .addItem('Diagnose', 'diagnose')
    .addSeparator()
    .addItem('Reset everything (wipe sheets)', 'resetAll')
    .addToUi();
}

// Returns null when there is no spreadsheet UI (script editor run, time trigger).
function ui_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null;
  }
}

function notify_(msg) {
  console.log(msg);
  const ui = ui_();
  if (ui) ui.alert(msg);
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupDealersSheet_(ss);
  setupLogSheet_(ss);
  notify_('Sheets ready. Next: set the Gemini API key, then start the automation.');
}

function setupDealersSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEETS.DEALERS);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEETS.DEALERS, 0);
  if (sheet.getLastRow() > 1) return removeObsoleteColumns_(sheet); // already seeded; never overwrite tracked data

  sheet.clear();
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold').setFontColor('#ffffff');
  let start = 1;
  COLUMN_GROUPS.forEach((g) => {
    sheet.getRange(1, start, 1, g.columns.length).setBackground(g.color);
    start += g.columns.length;
  });
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  const rows = DEALERS.map((d) => COLUMNS.map((c) => ({
    'Code': d.code,
    'Dealer': d.name,
    'City': d.city,
    'Email': d.email,
    'Phone': d.phone,
    'Website': d.website,
    'Distance (km)': distanceKm_(CONFIG.HOME, d),
    'Status': STATUS.WAITING,
  }[c] ?? '')));
  sheet.getRange(2, 1, rows.length, COLUMNS.length).setValues(rows);

  const col = (name) => COLUMNS.indexOf(name) + 1;
  const n = rows.length;
  ['Final total (Ft)', 'Paid accessories (Ft)', 'Freebies value (Ft)', 'Effective cost (Ft)']
    .forEach((c) => sheet.getRange(2, col(c), n, 1).setNumberFormat('#,##0 "Ft"'));
  sheet.getRange(2, col('Phone'), n, 1).setNumberFormat('@');
  sheet.getRange(2, col('Last reply'), n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(2, col('ETA'), n, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, col('Offer valid until'), n, 1).setNumberFormat('yyyy-mm-dd');

  const statusRange = sheet.getRange(2, col('Status'), n, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(STATUS).map((k) => STATUS[k]), true).setAllowInvalid(false).build());

  const colors = {};
  colors[STATUS.NOT_AVAILABLE] = '#f4cccc';
  colors[STATUS.IN_PRODUCTION] = '#fff2cc';
  colors[STATUS.IN_STOCK] = '#d9ead3';
  colors[STATUS.NEEDS_ACTION] = '#fce5cd';
  colors[STATUS.NEEDS_REVIEW] = '#fce5cd';
  const rules = Object.keys(colors).map((s) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(s).setBackground(colors[s]).setRanges([statusRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberEqualTo(1).setBackground('#93c47d').setBold(true)
    .setRanges([sheet.getRange(2, col('Rank'), n, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('MISMATCH').setFontColor('#cc0000')
    .setRanges([sheet.getRange(2, col('Config match'), n, 1)]).build());
  sheet.setConditionalFormatRules(rules);

  // Vertical divider after each column group.
  let end = 0;
  COLUMN_GROUPS.forEach((g) => {
    end += g.columns.length;
    sheet.getRange(1, end, n + 1, 1)
      .setBorder(null, null, null, true, null, null, '#666666', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });

  sheet.autoResizeColumns(1, COLUMNS.length);
  sheet.setColumnWidth(col('Config notes'), 250);
  sheet.setColumnWidth(col('Freebies'), 250);
  sheet.setColumnWidth(col('Summary'), 350);
  sheet.hideColumns(col(SORT_KEY_COLUMN));
}

function removeObsoleteColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  for (let i = headers.length - 1; i >= 0; i--) {
    if (OBSOLETE_COLUMNS.indexOf(headers[i]) !== -1) sheet.deleteColumn(i + 1);
  }
  addMissingColumns_(sheet);
}

// Columns added in newer versions: insert them next to their group neighbour, keeping existing data.
function addMissingColumns_(sheet) {
  COLUMNS.forEach((name, k) => {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    if (headers.indexOf(name) !== -1) return;
    const prev = k > 0 ? headers.indexOf(COLUMNS[k - 1]) + 1 : 0; // 1-based column to insert after (0 = first)
    if (prev > 0) sheet.insertColumnAfter(prev); else sheet.insertColumnBefore(1);
    const at = prev + 1;
    const group = COLUMN_GROUPS.find((g) => g.columns.indexOf(name) !== -1);
    sheet.getRange(1, at).setValue(name).setFontWeight('bold').setFontColor('#ffffff').setBackground(group ? group.color : null);
  });
}

// Deletes the Dealers and Log sheets and rebuilds them from scratch. API key and trigger are kept.
// Every matching email is re-analysed on the next run.
function resetAll() {
  const ui = ui_();
  if (!ui) throw new Error('Run "Reset everything" from the sheet menu (needs confirmation).');
  const answer = ui.alert('Reset everything?',
    'This permanently deletes all data in the "' + CONFIG.SHEETS.DEALERS + '" and "' + CONFIG.SHEETS.LOG +
    '" sheets and recreates them (all dealers back to "' + STATUS.WAITING + '"). All emails will be re-analysed on the next run.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(60000); // wait for a running processInbox to finish
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tmp = ss.insertSheet('_reset_tmp'); // a spreadsheet must always keep one sheet
    [CONFIG.SHEETS.DEALERS, CONFIG.SHEETS.LOG].forEach((name) => {
      const sh = ss.getSheetByName(name);
      if (sh) ss.deleteSheet(sh);
    });
    setupDealersSheet_(ss);
    setupLogSheet_(ss);
    ss.deleteSheet(tmp);
    ss.setActiveSheet(ss.getSheetByName(CONFIG.SHEETS.DEALERS));
  } finally {
    lock.releaseLock();
  }
  notify_('Reset done. Use "Run now" to analyse all emails again.');
}

function setupLogSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEETS.LOG);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEETS.LOG);
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setValues([LOG_COLUMNS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function distanceKm_(a, b) {
  if (b.lat == null || b.lng == null) return '';
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

function promptApiKey() {
  const ui = ui_();
  if (!ui) throw new Error('Run this from the spreadsheet menu: Suzuki Bot → Set Gemini API key.');
  const res = ui.prompt('Gemini API key', 'Paste your Google AI Studio API key:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK || !res.getResponseText().trim()) return;
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', res.getResponseText().trim());
  ui.alert('API key saved in Script Properties.');
}

function startAutomation() {
  stopAutomation_();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  notify_('Automation started: inbox checked every ' + CONFIG.TRIGGER_MINUTES + ' minutes (read-only).');
}

function stopAutomation() {
  stopAutomation_();
  notify_('Automation stopped.');
}

function stopAutomation_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'processInbox')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

// Shows which Gmail account is read and how many emails each search finds.
function diagnose() {
  const since = ' after:' + CONFIG.SEARCH_SINCE;
  const count = (q) => (Gmail.Users.Messages.list('me', { q, maxResults: 500, includeSpamTrash: true }).messages || []).length;
  const lines = [
    'Gmail account read by the bot: ' + Gmail.Users.getProfile('me').emailAddress,
    'Gemini API key set: ' + (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') ? 'yes' : 'NO'),
    'Automation trigger active: ' + (ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'processInbox') ? 'yes' : 'no'),
    '',
    'Emails found since ' + CONFIG.SEARCH_SINCE + ':',
    '- bot search: ' + listMessageIds_(buildSearchQueries_()).length,
    '- all emails: ' + count('-in:trash' + since),
    '- with PDF attachment: ' + count('filename:pdf -in:trash' + since),
  ];
  CONFIG.FORWARDERS.forEach((e) => lines.push('- from ' + e + ': ' + count('from:' + e + ' -in:trash' + since)));
  const log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  lines.push('', 'Rows in Log: ' + (log ? Math.max(0, log.getLastRow() - 1) : 'no Log sheet'));
  notify_(lines.join('\n'));
}
