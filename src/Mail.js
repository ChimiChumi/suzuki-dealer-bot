// Read-only Gmail access via the Gmail advanced service (scope: gmail.readonly). Nothing here can send or modify mail.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function extractEmails_(text) {
  return (String(text || '').match(EMAIL_RE) || []).map((e) => e.toLowerCase());
}

function domainOf_(email) {
  return String(email || '').toLowerCase().split('@')[1] || '';
}

function isGenericDomain_(domain) {
  return CONFIG.GENERIC_DOMAINS.indexOf(domain) !== -1;
}

function buildSearchQuery_() {
  const terms = {};
  DEALERS.forEach((d) => {
    [d.email, d.serviceEmail].filter(Boolean).forEach((e) => {
      const dom = domainOf_(e);
      terms[isGenericDomain_(dom) ? e : dom] = true;
    });
    if (d.websiteDomain && !isGenericDomain_(d.websiteDomain)) terms[d.websiteDomain] = true;
  });
  const senders = Object.keys(terms).map((t) => 'from:' + t);
  CONFIG.FORWARDERS.forEach((e) => senders.push('from:' + e));
  if (CONFIG.OUTREACH_SUBJECT) senders.push('subject:"' + CONFIG.OUTREACH_SUBJECT.replace(/"/g, '') + '"');
  // No -from:me: a forward from your own alias would be excluded. Own sent mail is skipped in code instead.
  return '-in:trash after:' + CONFIG.SEARCH_SINCE + ' {' + senders.join(' ') + '}';
}

function listMessageIds_(query) {
  const ids = [];
  let pageToken;
  do {
    const res = Gmail.Users.Messages.list('me', { q: query, maxResults: 100, pageToken, includeSpamTrash: true });
    (res.messages || []).forEach((m) => ids.push(m.id));
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < 1000);
  return ids;
}

// The Gmail advanced service returns byte fields as byte arrays; the REST API returns base64url strings. Accept both.
function bytesOf_(data) {
  return typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
}

function decodePart_(data, charset) {
  const bytes = bytesOf_(data);
  try {
    return Utilities.newBlob(bytes).getDataAsString(charset || 'UTF-8');
  } catch (e) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
}

function headerValue_(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function charsetOf_(part) {
  const m = /charset="?([^";\s]+)"?/i.exec(headerValue_(part.headers, 'Content-Type'));
  return m ? m[1] : 'UTF-8';
}

function htmlToText_(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function getEmail_(messageId) {
  const msg = Gmail.Users.Messages.get('me', messageId, { format: 'full' });
  const headers = msg.payload.headers;
  const from = headerValue_(headers, 'From');
  const out = {
    id: msg.id,
    threadId: msg.threadId,
    from,
    fromEmail: extractEmails_(from)[0] || '',
    subject: headerValue_(headers, 'Subject'),
    date: new Date(Number(msg.internalDate)),
    labelIds: msg.labelIds || [],
    body: '',
    pdfs: [],
    attachmentNames: [],
  };

  let plain = '';
  let html = '';
  const walk = (part) => {
    const mime = (part.mimeType || '').toLowerCase();
    const filename = part.filename || '';
    if (filename) {
      out.attachmentNames.push(filename);
      const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename);
      const size = (part.body && part.body.size) || 0;
      if (isPdf && size <= CONFIG.MAX_PDF_BYTES) {
        const data = part.body.attachmentId
          ? Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId).data
          : part.body.data;
        if (data && data.length) out.pdfs.push({ name: filename, base64: Utilities.base64Encode(bytesOf_(data)) });
      }
    } else if (part.body && part.body.data) {
      if (mime === 'text/plain' && !plain) plain = decodePart_(part.body.data, charsetOf_(part));
      if (mime === 'text/html' && !html) html = decodePart_(part.body.data, charsetOf_(part));
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);

  out.body = (plain || htmlToText_(html) || msg.snippet || '').slice(0, CONFIG.MAX_BODY_CHARS);

  if (isForwarder_(out.fromEmail)) {
    const original = forwardedSender_(out.body);
    if (original) {
      out.from = original + ' (forwarded by ' + out.fromEmail + ')';
      out.fromEmail = extractEmails_(original)[0];
    }
  }
  return out;
}

function isForwarder_(email) {
  return CONFIG.FORWARDERS.map((e) => e.toLowerCase()).indexOf(email) !== -1;
}

// First "From:" line of a forwarded block (Apple Mail, Gmail, Outlook; EN/HU/DE) that isn't one of your own addresses.
function forwardedSender_(body) {
  const re = /^[ \t>*]*(?:From|Feladó|Von|De|Kimden)[ \t]*:[ \t*]*(.+)$/gim;
  let m;
  while ((m = re.exec(body))) {
    const email = extractEmails_(m[1])[0];
    if (email && !isForwarder_(email)) return m[1].replace(/\*/g, '').trim();
  }
  return '';
}

// Addresses you wrote to in this thread (works when dealers reply from a personal address).
function sentRecipientsInThread_(threadId) {
  const thread = Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: ['To', 'Cc'] });
  const emails = [];
  (thread.messages || [])
    .filter((m) => (m.labelIds || []).indexOf('SENT') !== -1)
    .forEach((m) => {
      emails.push.apply(emails, extractEmails_(headerValue_(m.payload.headers, 'To')));
      emails.push.apply(emails, extractEmails_(headerValue_(m.payload.headers, 'Cc')));
    });
  return emails;
}
