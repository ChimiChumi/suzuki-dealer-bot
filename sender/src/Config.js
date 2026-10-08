// Outreach sender settings. This project is separate from the read-only reader bot on purpose:
// it can only SEND (scope gmail.send), it cannot read your mailbox.

const SENDER_CONFIG = {
  // Sending is refused unless the authorized Google account is exactly this address.
  EXPECTED_SENDER: 'doboshuni@gmail.com',
  FROM_NAME: 'Dobos Hunor',

  // "Send TEST emails" can only ever send to these addresses.
  TEST_RECIPIENTS: [
    'doboshuni@icloud.com',
    'doboshuni.stud@gmail.com',
    'doboshuni.social@gmail.com',
    'doboshuni.promo@gmail.com',
    'doboshuni.gaming@gmail.com',
  ],

  // ASCII file name: avoids broken accented names in older mail clients.
  ATTACHMENT_NAME: 'Konfiguracio - Suzuki S-Cross GLX Urban Black.pdf',

  // Live sending pace: random pause between emails, and a per-click time budget
  // (Apps Script stops any execution after 6 minutes; click again to continue).
  MIN_DELAY_MS: 4000,
  MAX_DELAY_MS: 8000,
  RUN_BUDGET_MS: 4.5 * 60 * 1000,

  SHEETS: { RECIPIENTS: 'Recipients', TEST_LOG: 'Test log', PREVIEW: 'Preview' },
};

const SEND_STATUS = { SENDING: 'SENDING', SENT: 'SENT', FAILED: 'FAILED' };

const RECIPIENT_COLUMNS = ['Send', 'Email', 'Dealer codes', 'Dealers', 'Status', 'Sent at', 'Message ID', 'Error'];
const TEST_LOG_COLUMNS = ['Sent at', 'To', 'Content hash', 'Message ID', 'Result'];
