// Builds the raw MIME message. Pure string work: nothing here sends anything.

const SINGLE_EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function isValidEmail_(email) {
  return SINGLE_EMAIL_RE.test(String(email || ''));
}

function utf8Length_(s) {
  return encodeURIComponent(s).replace(/%[0-9A-F]{2}/gi, 'x').length;
}

// RFC 2047 encoded words, split on character boundaries (each word stays under 75 chars).
function encodeHeader_(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  Array.from(text).forEach((ch) => {
    if (chunk && utf8Length_(chunk + ch) > 42) {
      words.push(chunk);
      chunk = ch;
    } else {
      chunk += ch;
    }
  });
  if (chunk) words.push(chunk);
  return words.map((w) => '=?UTF-8?B?' + Utilities.base64Encode(w, Utilities.Charset.UTF_8) + '?=').join('\r\n ');
}

function wrap76_(b64) {
  return b64.match(/.{1,76}/g).join('\r\n');
}

function buildMime_(to) {
  // Exactly one plain address per message: no lists, no CC/BCC, no header injection.
  if (!isValidEmail_(to)) throw new Error('Refusing to build email: invalid single recipient "' + to + '"');
  const boundary = 'suzuki_' + Utilities.getUuid().replace(/-/g, '');
  const name = SENDER_CONFIG.ATTACHMENT_NAME;
  const mime = [
    'From: ' + encodeHeader_(SENDER_CONFIG.FROM_NAME) + ' <' + SENDER_CONFIG.EXPECTED_SENDER + '>',
    'To: ' + to,
    'Subject: ' + encodeHeader_(EMAIL_SUBJECT),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed;',
    ' boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76_(Utilities.base64Encode(EMAIL_BODY.replace(/\r?\n/g, '\r\n'), Utilities.Charset.UTF_8)),
    '--' + boundary,
    'Content-Type: application/pdf;',
    ' name="' + name + '"',
    'Content-Disposition: attachment;',
    ' filename="' + name + '"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76_(ATTACHMENT_BASE64),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
  if (!/^[\x00-\x7f]*$/.test(mime)) throw new Error('MIME must be pure ASCII');
  return mime;
}

function sha256Hex_(input) {
  const bytes = typeof input === 'string'
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return Array.prototype.map.call(bytes, (b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

// Identifies the exact content sent. LIVE requires a TEST send with the same hash.
function contentHash_() {
  return sha256Hex_(JSON.stringify([
    SENDER_CONFIG.FROM_NAME, SENDER_CONFIG.EXPECTED_SENDER, EMAIL_SUBJECT, EMAIL_BODY,
    SENDER_CONFIG.ATTACHMENT_NAME, ATTACHMENT_SHA256,
  ]));
}

function attachmentIntact_() {
  const bytes = Utilities.base64Decode(ATTACHMENT_BASE64);
  return bytes.length === ATTACHMENT_BYTES && sha256Hex_(bytes) === ATTACHMENT_SHA256;
}
