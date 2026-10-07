// Edit these values to tune the bot. The Gemini API key lives in Script Properties (menu: Suzuki Bot → Set Gemini API key).

const CONFIG = {
  GEMINI_MODEL: 'gemini-3.5-flash',

  // Only emails received on/after this date (YYYY/MM/DD) are analysed.
  SEARCH_SINCE: '2026/10/01',
  // Optional: subject of your outreach email. Replies ("Re: ...") from unknown addresses are then also picked up.
  OUTREACH_SUBJECT: '',

  // Your own addresses you manually forward dealer emails from. The original dealer sender is read from the forwarded header.
  FORWARDERS: ['doboshuni@icloud.com'],

  MAX_MESSAGES_PER_RUN: 15,
  TRIGGER_MINUTES: 10,
  MAX_PDF_BYTES: 15 * 1024 * 1024,
  MAX_BODY_CHARS: 20000,

  // Strict match: anything else counts as "not available".
  TARGET: {
    model: 'Suzuki S-Cross',
    trim: 'GLX Urban Black (same edition is also called "Special Edition" / "SPEC. ED.")',
    engine: '1.4 BoosterJet Hybrid (48V mild hybrid)',
    gearbox: '6-speed automatic (6AT)',
    drive: '4WD ALLGRIP',
    roof: 'Panoramic glass roof (panorámatető)',
    color: 'Titánszürke (Titan Grey / Titanium Grey)',
  },

  HOME: { name: 'Budapest', lat: 47.4979, lng: 19.0402 },

  // Effective cost = final total − winter tires − other freebies + delay cost + pickup distance cost. Lower is better.
  SCORING: {
    WINTER_TIRES_VALUE_HUF: 300000,
    DELAY_COST_PER_WEEK_HUF: 10000,
    COST_PER_KM_HUF: 100,
    // Dealer-added paid accessories (floor mats, trunk tray...) are optional, so leave them out of the comparison.
    EXCLUDE_PAID_ACCESSORIES: true,
  },

  SHEETS: { DEALERS: 'Dealers', LOG: 'Log' },

  // Free-mail domains: dealers using these are matched by exact address only.
  GENERIC_DOMAINS: [
    'gmail.com', 'googlemail.com', 't-online.hu', 'freemail.hu', 'citromail.hu', 'yahoo.com',
    'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'invitel.hu', 'vipmail.hu', 'upcmail.hu',
  ],
};

const STATUS = {
  WAITING: 'Waiting for response',
  NOT_AVAILABLE: 'Not available',
  IN_PRODUCTION: 'In production',
  IN_STOCK: 'In stock',
  NEEDS_ACTION: 'Needs action',
  NEEDS_REVIEW: 'Needs review',
};

// Dealers sheet columns, grouped left to right; each group gets its own header colour.
const COLUMN_GROUPS = [
  { color: '#1f3864', columns: ['Code', 'Dealer', 'City', 'Distance (km)'] },
  { color: '#274e13', columns: ['Status', 'Rank', 'Effective cost (Ft)'] },
  { color: '#7f6000', columns: ['Config match', 'Config notes', 'Summary'] },
  { color: '#660000', columns: ['ETA', 'Final total (Ft)', 'Paid accessories (Ft)', 'Winter tires', 'Freebies', 'Freebies value (Ft)', 'Offer valid until'] },
  { color: '#434343', columns: ['Last reply', 'Thread', 'Email', 'Phone', 'Website'] },
];
const COLUMNS = COLUMN_GROUPS.reduce((all, g) => all.concat(g.columns), []);

// Columns removed from earlier versions; Setup deletes them from existing sheets.
const OBSOLETE_COLUMNS = ['List price (Ft)', 'Discount (Ft)'];

const LOG_COLUMNS = ['Processed at', 'Message ID', 'Received', 'From', 'Subject', 'Dealer codes', 'Result', 'Notes'];
