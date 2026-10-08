// Time-triggered entry point: read new dealer emails, analyse with Gemini, update the sheet. Never sends email.

function processInbox() {
  const stats = { account: '', found: 0, pending: 0, processed: 0, errors: 0, lastError: '', rateLimited: false };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return stats;
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error('Missing Gemini API key. Use menu: Suzuki Bot → Set Gemini API key.');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const table = new SheetTable_(ss.getSheetByName(CONFIG.SHEETS.DEALERS));
    const logSheet = ss.getSheetByName(CONFIG.SHEETS.LOG);
    if (!table.sheet || !logSheet) throw new Error('Run "Setup sheets" first.');

    stats.account = Gmail.Users.getProfile('me').emailAddress;
    const done = processedMessageIds_(logSheet);
    const found = listMessageIds_(buildSearchQueries_());
    const pending = found.filter((id) => !done[id]).reverse(); // oldest first
    stats.found = found.length;
    stats.pending = pending.length;
    const index = buildDealerIndex_();
    const today = Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd');
    const start = Date.now();

    for (const id of pending.slice(0, CONFIG.MAX_MESSAGES_PER_RUN)) {
      if (Date.now() - start > CONFIG.RUN_BUDGET_MS) break; // the rest stays pending for the next run
      let email = { id, from: '', subject: '', date: '' };
      let codes = [];
      try {
        email = getEmail_(id);
        stats.processed++;
        if (email.labelIds.indexOf('SENT') !== -1 && !isForwarder_(email.fromEmail)) {
          appendLog_(logSheet, email, [], 'SKIPPED', 'Your own sent message');
          continue;
        }
        // Unknown sender (e.g. salesperson's private address): let Gemini identify the dealer from the signature.
        const matched = findCandidates_(email, index);
        const candidates = matched.length ? matched : DEALERS;
        const a = analyzeEmail_(apiKey, email, candidates, today);
        const picked = candidates.filter((d) => d.code === a.dealerCode);
        if (!matched.length && !picked.length) {
          appendLog_(logSheet, email, [], 'UNMATCHED', 'Dealer not identified. ' + a.summary);
          continue;
        }
        codes = (picked.length ? picked : candidates).map((d) => d.code);
        if (!a.isRelevant) {
          appendLog_(logSheet, email, codes, 'IGNORED', a.summary);
          continue;
        }
        const status = statusFromAnalysis_(a);
        let result = status;
        codes.forEach((code) => {
          const current = table.get(code);
          if (current && isFollowUpOnly_(a, status, current['Status'])) {
            result = 'FOLLOW-UP (kept ' + current['Status'] + ')';
            table.update(code, followUpUpdates_(a, email, current));
          } else {
            table.update(code, rowUpdates_(a, status, email));
          }
        });
        appendLog_(logSheet, email, codes, result, a.summary);
      } catch (e) {
        // Rate limit / overload: stop now, the message stays pending for the next run.
        if (e && e.retryable) {
          stats.processed--;
          stats.rateLimited = true;
          break;
        }
        stats.errors++;
        stats.lastError = String(e && e.message ? e.message : e);
        console.error(stats.lastError);
        appendLog_(logSheet, email, codes, 'ERROR', stats.lastError);
      }
    }

    recomputeRanking_(table);
    console.log(JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

// Menu version of processInbox with visible feedback.
function runNow() {
  const s = processInbox();
  notify_([
    'Gmail account: ' + s.account,
    'Matching emails since ' + CONFIG.SEARCH_SINCE + ': ' + s.found,
    'New (not yet in Log): ' + s.pending,
    'Processed now: ' + s.processed,
    s.errors ? 'Errors: ' + s.errors + ' (see Log sheet). Last: ' + s.lastError : '',
    s.rateLimited ? 'Gemini rate limit hit: the rest will be processed on the next run.' : '',
    s.pending > s.processed + s.errors && !s.rateLimited ? 'More remaining: they will be processed on the next runs.' : '',
  ].filter(Boolean).join('\n'));
}

// Removes ERROR rows from the Log so those emails are analysed again, then runs.
function retryFailed() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  const resCol = LOG_COLUMNS.indexOf('Result');
  const n = sheet.getLastRow() - 1;
  if (n < 1) return runNow();
  const range = sheet.getRange(2, 1, n, LOG_COLUMNS.length);
  const rows = range.getValues();
  const kept = rows.filter((r) => r[resCol] !== 'ERROR');
  const removed = rows.length - kept.length;
  // Rewrite instead of deleteRow: Sheets refuses to delete all non-frozen rows.
  range.clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, LOG_COLUMNS.length).setValues(kept);
  console.log('Removed ' + removed + ' ERROR rows');
  runNow();
}

function recomputeRanking() {
  recomputeRanking_(new SheetTable_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DEALERS)));
}

// ---------- matching ----------

function buildDealerIndex_() {
  const byEmail = {};
  const byDomain = {};
  const add = (map, key, d) => {
    if (!key) return;
    map[key] = map[key] || [];
    if (map[key].indexOf(d) === -1) map[key].push(d);
  };
  DEALERS.forEach((d) => {
    [d.email, d.serviceEmail].filter(Boolean).forEach((e) => {
      add(byEmail, e, d);
      if (!isGenericDomain_(domainOf_(e))) add(byDomain, domainOf_(e), d);
    });
    if (d.websiteDomain && !isGenericDomain_(d.websiteDomain)) add(byDomain, d.websiteDomain, d);
  });
  return { byEmail, byDomain };
}

function findCandidates_(email, index) {
  if (index.byEmail[email.fromEmail]) return index.byEmail[email.fromEmail];

  const fromThread = [];
  sentRecipientsInThread_(email.threadId).forEach((e) => {
    (index.byEmail[e] || []).forEach((d) => fromThread.indexOf(d) === -1 && fromThread.push(d));
  });
  if (fromThread.length) return fromThread;

  const dom = domainOf_(email.fromEmail);
  if (isGenericDomain_(dom)) return [];
  // Also match sub-domains, e.g. mail.kovesdan.hu → kovesdan.hu
  const key = Object.keys(index.byDomain).find((k) => dom === k || dom.endsWith('.' + k));
  return key ? index.byDomain[key] : [];
}

// ---------- analysis → sheet ----------

function statusFromAnalysis_(a) {
  if (a.configMatch === 'MISMATCH') return STATUS.NOT_AVAILABLE;
  // Strict match: an offered car with unconfirmed attributes (e.g. colour) must be checked by hand before ranking.
  if (a.configMatch === 'UNCLEAR' && (a.availability === 'IN_STOCK' || a.availability === 'IN_PRODUCTION')) {
    return STATUS.NEEDS_REVIEW;
  }
  return {
    IN_STOCK: STATUS.IN_STOCK,
    IN_PRODUCTION: STATUS.IN_PRODUCTION,
    NOT_AVAILABLE: STATUS.NOT_AVAILABLE,
    NEEDS_ACTION: STATUS.NEEDS_ACTION,
  }[a.availability] || STATUS.NEEDS_REVIEW;
}

function rowUpdates_(a, status, email) {
  const u = {
    'Status': status,
    'Config match': a.configMatch,
    'Config notes': a.configNotes,
    'Summary': a.summary,
    'Last reply': email.date,
    'Thread': 'https://mail.google.com/mail/u/0/#all/' + email.threadId,
  };
  const offerCols = ['ETA', 'Paid accessories (Ft)', 'Final total (Ft)', 'Winter tires', 'Freebies', 'Freebies value (Ft)', 'Offer valid until'];
  // Not available: clear offer cells so no ETA/price of a different car (or an outdated offer) stays on the row.
  if (status === STATUS.NOT_AVAILABLE) {
    offerCols.forEach((c) => { u[c] = ''; });
    return u;
  }
  // ETA/offer cells are only about the target car itself. Needs action: keep whatever is already there.
  if ([STATUS.IN_STOCK, STATUS.IN_PRODUCTION, STATUS.NEEDS_REVIEW].indexOf(status) === -1) return u;
  if (a.estimatedDelivery) u['ETA'] = a.estimatedDelivery;
  else if (a.availability === 'IN_STOCK') u['ETA'] = 'In stock';
  if (a.hasOffer && a.finalTotalGross > 0) {
    Object.assign(u, {
      'Paid accessories (Ft)': a.paidAccessoriesTotal || 0,
      'Final total (Ft)': a.finalTotalGross,
      'Winter tires': a.includesWinterTires ? 'Yes' : 'No',
      'Freebies': [a.freebies, a.paidAccessories && 'Paid: ' + a.paidAccessories].filter(Boolean).join(' | '),
      'Freebies value (Ft)': a.freebiesValue || 0,
      'Offer valid until': a.offerValidUntil || '',
    });
  }
  return u;
}

// A later email without new availability/offer info (e.g. "did you get our offer? call me") must not
// overwrite a clear earlier answer. It is appended to the Summary instead.
function isFollowUpOnly_(a, status, currentStatus) {
  const decided = [STATUS.IN_STOCK, STATUS.IN_PRODUCTION, STATUS.NOT_AVAILABLE];
  if (decided.indexOf(currentStatus) === -1) return false;
  const hasNewInfo = decided.indexOf(status) !== -1 || (a.hasOffer && a.finalTotalGross > 0);
  return !hasNewInfo;
}

function followUpUpdates_(a, email, current) {
  const day = Utilities.formatDate(email.date, 'Europe/Budapest', 'yyyy-MM-dd');
  const summary = [current['Summary'], 'Follow-up ' + day + ': ' + a.summary].filter(Boolean).join('\n');
  return {
    'Summary': summary.slice(-2000),
    'Last reply': email.date,
    'Thread': 'https://mail.google.com/mail/u/0/#all/' + email.threadId,
  };
}

function weeksUntil_(eta, now) {
  if (!eta || eta === 'In stock') return 0;
  let date = eta instanceof Date ? eta : null; // Sheets auto-converts "2026-11" into a Date
  if (!date) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(eta));
    if (!m) return 0;
    date = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 15);
  }
  return Math.max(0, (date - now) / (7 * 24 * 3600 * 1000));
}

function effectiveCost_(row, now) {
  const s = CONFIG.SCORING;
  const num = (v) => Number(v) || 0;
  let cost = num(row['Final total (Ft)']);
  if (s.EXCLUDE_PAID_ACCESSORIES) cost -= num(row['Paid accessories (Ft)']);
  if (row['Winter tires'] === 'Yes') cost -= s.WINTER_TIRES_VALUE_HUF;
  cost -= num(row['Freebies value (Ft)']);
  cost += weeksUntil_(row['ETA'], now) * s.DELAY_COST_PER_WEEK_HUF;
  cost += num(row['Distance (km)']) * s.COST_PER_KM_HUF;
  return Math.round(cost);
}

function isRankable_(row) {
  return (row['Status'] === STATUS.IN_STOCK || row['Status'] === STATUS.IN_PRODUCTION) &&
    row['Config match'] === 'EXACT' &&
    Number(row['Final total (Ft)']) > 0;
}

function recomputeRanking_(table) {
  const now = new Date();
  const scored = table.rows()
    .filter(isRankable_)
    .map((r) => ({ code: r['Code'], cost: effectiveCost_(r, now) }))
    .sort((x, y) => x.cost - y.cost);
  const rankByCode = {};
  scored.forEach((s, i) => { rankByCode[s.code] = { cost: s.cost, rank: i + 1 }; });
  table.writeColumns(['Effective cost (Ft)', 'Rank'], (r) => {
    const s = rankByCode[r['Code']];
    return s ? [s.cost, s.rank] : ['', ''];
  });
}

// ---------- sheet helpers ----------

function SheetTable_(sheet) {
  this.sheet = sheet;
  if (!sheet) return;
  this.headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

SheetTable_.prototype.col = function (name) {
  const i = this.headers.indexOf(name);
  if (i === -1) throw new Error('Missing column "' + name + '" in ' + this.sheet.getName());
  return i;
};

SheetTable_.prototype.rows = function () {
  const n = this.sheet.getLastRow() - 1;
  if (n < 1) return [];
  return this.sheet.getRange(2, 1, n, this.headers.length).getValues().map((vals) => {
    const o = {};
    this.headers.forEach((h, i) => { o[h] = vals[i]; });
    return o;
  });
};

SheetTable_.prototype.get = function (code) {
  return this.rows().find((r) => String(r['Code']) === code) || null;
};

SheetTable_.prototype.update = function (code, updates) {
  const codes = this.sheet.getRange(2, this.col('Code') + 1, Math.max(1, this.sheet.getLastRow() - 1), 1).getValues();
  const idx = codes.findIndex((r) => String(r[0]) === code);
  if (idx === -1) return;
  Object.keys(updates).forEach((name) => {
    this.sheet.getRange(idx + 2, this.col(name) + 1).setValue(updates[name]);
  });
};

SheetTable_.prototype.writeColumns = function (names, fn) {
  const rows = this.rows();
  if (!rows.length) return;
  const values = rows.map(fn);
  names.forEach((name, j) => {
    this.sheet.getRange(2, this.col(name) + 1, rows.length, 1).setValues(values.map((v) => [v[j]]));
  });
};

function processedMessageIds_(logSheet) {
  const n = logSheet.getLastRow() - 1;
  const done = {};
  if (n < 1) return done;
  const errors = {};
  const idCol = LOG_COLUMNS.indexOf('Message ID');
  const resCol = LOG_COLUMNS.indexOf('Result');
  logSheet.getRange(2, 1, n, LOG_COLUMNS.length).getValues().forEach((r) => {
    const id = String(r[idCol]);
    if (r[resCol] === 'ERROR') {
      errors[id] = (errors[id] || 0) + 1;
      if (errors[id] >= 3) done[id] = true; // give up after 3 failed attempts
    } else {
      done[id] = true;
    }
  });
  return done;
}

function appendLog_(logSheet, email, codes, result, notes) {
  logSheet.appendRow([new Date(), email.id, email.date, email.from, email.subject, codes.join(', '), result, notes]);
}
