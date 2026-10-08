# Suzuki Dealer Bot

Google Apps Script bound to the **Suzuki Dealer Tracker** sheet. It reads dealer replies in Gmail, analyses them (and attached PDF offers) with Gemini, and keeps the `Dealers` tab up to date with availability, offer details and a ranking of the best deals.

**Read-only by design:** Gmail is accessed only through the `gmail.readonly` scope. The script cannot send, delete or modify email.

## Setup

1. Open the sheet → reload → menu **Suzuki Bot**.
2. **1. Setup sheets** – creates `Dealers` (seeded with all dealers, status *Waiting for response*) and `Log`. Accept the authorization prompt.
3. **2. Set Gemini API key** – stored in Script Properties, never in code.
4. **3. Start automation** – checks the inbox every 10 minutes.

Use **Run now** to process immediately (shows a summary), **Stop automation** to pause, **Diagnose** to see which Gmail account is read and how many emails match, **Retry failed emails** to clear ERROR rows from the Log and re-analyse them, **Reset everything** to wipe both sheets and start from scratch (API key and automation kept; all emails re-analysed).

## Statuses

| Status | Meaning |
|---|---|
| Waiting for response | No reply yet |
| Not available | Not in stock, no ETA, or only a different configuration offered. ETA and offer cells are left empty; the alternative offer is described in Config notes |
| In production | Exact config ordered/arriving; see `ETA` |
| In stock | Exact config available now |
| Needs action | Dealer asks you to call/visit/provide info |
| Needs review | AI could not decide, or the offered car's config (e.g. colour) is not confirmed; check the thread, then fix `Status`/`Config match` by hand |

`Config match` = `EXACT` / `UNCLEAR` / `MISMATCH` against the strict target in `src/Config.js`.

Once a dealer is `In stock`, `In production` or `Not available`, a later email from them that brings no new availability or price (e.g. "did you get our offer? please call") does not change the row: it is appended to `Summary` as "Follow-up …" and logged as `FOLLOW-UP`.

## Ranking

Rows with status *In stock* / *In production*, a price, and `Config match` = `EXACT` are ranked by **Effective cost** (lower is better):

```
final gross total − paid accessories − winter tires value − freebies value + weeks until delivery × weekly cost + km from Budapest × per-km cost
```

Weights live in `CONFIG.SCORING` (`src/Config.js`).

## Dealer matching

Reply sender → exact dealer email → recipients of your own sent message in the same thread → dealer domain (free-mail domains excluded). When several branches share a domain, Gemini picks the branch from the signature. If the sender is unknown (e.g. a salesperson's private address), Gemini identifies the dealer from the signature/address; if it can't, the email is logged as `UNMATCHED`. Automatic acknowledgements ("offer will be sent soon") are logged as `IGNORED` and don't change the status.

Emails you manually forward from an address in `CONFIG.FORWARDERS` (e.g. iCloud → Gmail) are attributed to the original sender from the forwarded `From:`/`Feladó:` header.

To re-analyse an email, delete its row in `Log`; it is picked up on the next run.

## Outreach sender (separate project: `sender/`)

The initial inquiry email is sent by a **separate** Apps Script project bound to the **Suzuki Outreach Sender** sheet, so the reader bot above stays read-only. The sender has only the `gmail.send` scope: it cannot read your mailbox.

- Content: `sender/src/Template.js` (subject, body) and the embedded configuration PDF (`sender/src/Attachment.js`).
- Recipients: 73 unique dealer addresses in the `Recipients` tab (untick **Send** to skip a dealer). One separate email per address, single `To`, no CC/BCC.

Menu **Outreach**:
1. **Setup sheets** – creates `Recipients` and `Test log` (never overwrites existing data).
2. **Preview** – writes the exact content and recipient list to the `Preview` tab. Sends nothing.
3. **Send TEST emails** – sends only to the addresses in `SENDER_CONFIG.TEST_RECIPIENTS`. Unlocks LIVE for exactly this content.
4. **Send LIVE to dealers** – requires: the authorized account is `doboshuni@gmail.com`, a TEST with identical content (any change re-locks), no row stuck in `SENDING`, no invalid/duplicate addresses, and typing `SEND <n>`. Sends for up to ~4.5 minutes per click with 4–8 s gaps, stops on the first error; click again to continue. `SENT` rows are never resent.

If a row stays `SENDING` (run died mid-send), check Gmail's Sent folder, then set it to `SENT` or clear it.

## Development

```bash
python3 scripts/build-dealers.py         # regenerate src/Dealers.js after editing dealer_data.json
python3 scripts/build-sender-assets.py   # regenerate sender/src/Recipients.js + Attachment.js (PDF)
npx @google/clasp@3 push -f              # deploy src/ (reader bot)
cd sender && npx @google/clasp@3 push -f # deploy the outreach sender
```

Gemini free tier allows ~20 requests/day per model; enable billing on the API key's project for real use. Rate-limited messages are retried automatically on the next run.
