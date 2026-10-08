// Gemini analysis of one dealer email (+ PDF offers).

const ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isRelevant: { type: 'BOOLEAN', description: 'False for automatic acknowledgements that an offer will be sent later, auto-replies, out-of-office, newsletters, or anything that gives no availability/offer information.' },
    dealerCode: { type: 'STRING', description: 'Code of the candidate dealer that sent this email, or empty if unsure.' },
    availability: { type: 'STRING', enum: ['IN_STOCK', 'IN_PRODUCTION', 'NOT_AVAILABLE', 'NEEDS_ACTION', 'UNCLEAR'] },
    configMatch: { type: 'STRING', enum: ['EXACT', 'MISMATCH', 'UNCLEAR'] },
    configNotes: { type: 'STRING', description: 'Which target attributes differ or are not confirmed. If the dealer offers a different configuration, also briefly describe that alternative here (colour, availability date, price). Empty if exact.' },
    estimatedDelivery: { type: 'STRING', description: 'Earliest delivery of the EXACT target configuration as YYYY-MM-DD or YYYY-MM. Empty if unknown or if only a different configuration is offered.' },
    hasOffer: { type: 'BOOLEAN', description: 'True if a concrete price offer is present (email or PDF).' },
    paidAccessoriesTotal: { type: 'NUMBER', description: 'Sum of paid dealer-added accessories in HUF (0 if none).' },
    paidAccessories: { type: 'STRING', description: 'Comma separated list of paid accessories with prices.' },
    finalTotalGross: { type: 'NUMBER', description: 'Total gross amount the buyer pays in HUF incl. VAT, registration tax and registration/forgalomba helyezés costs (0 if unknown).' },
    includesWinterTires: { type: 'BOOLEAN', description: 'True only if a winter tire/wheel set is included FREE of charge.' },
    freebies: { type: 'STRING', description: 'Comma separated free extras (excluding winter tires and standard manufacturer warranty/assistance that every dealer gives).' },
    freebiesValue: { type: 'NUMBER', description: 'Conservative estimated HUF market value of the listed freebies (excluding winter tires). 0 if none.' },
    offerValidUntil: { type: 'STRING', description: 'Offer validity date YYYY-MM-DD, empty if unknown.' },
    summary: { type: 'STRING', description: 'One or two sentence English summary of the reply. Mention any questions the dealer asks the customer.' },
  },
  required: [
    'isRelevant', 'dealerCode', 'availability', 'configMatch', 'configNotes', 'estimatedDelivery', 'hasOffer',
    'paidAccessoriesTotal', 'paidAccessories', 'finalTotalGross',
    'includesWinterTires', 'freebies', 'freebiesValue', 'offerValidUntil', 'summary',
  ],
};

function buildPrompt_(email, candidates, today) {
  const t = CONFIG.TARGET;
  const cands = candidates
    .map((d) => `- ${d.code}: ${d.name} (${d.city}) emails: ${[d.email, d.serviceEmail].filter(Boolean).join(', ')}`)
    .join('\n');
  return [
    'You analyse replies from Hungarian Suzuki dealers to a customer asking whether they have one exact car configuration and for their best offer.',
    'Emails and PDF offers are usually in Hungarian. Today is ' + today + '.',
    '',
    'TARGET CONFIGURATION (strict, every attribute must match):',
    `- Model: ${t.model}`,
    `- Trim/edition: ${t.trim}`,
    `- Engine: ${t.engine}`,
    `- Gearbox: ${t.gearbox}`,
    `- Drive: ${t.drive}`,
    `- Roof: ${t.roof}`,
    `- Colour: ${t.color}`,
    '',
    'availability (always about the exact target configuration):',
    '- IN_STOCK: dealer has it now / can deliver from stock.',
    '- IN_PRODUCTION: not in stock, but this exact car is ordered/registered from the factory or arriving with a known ETA (fill estimatedDelivery).',
    '- NOT_AVAILABLE: not in stock and no ETA, unknown arrival, discontinued, or the dealer only offers a different configuration.',
    '- NEEDS_ACTION: dealer asks the customer to call, visit or provide information before answering availability.',
    '- UNCLEAR: cannot be determined.',
    'Judge availability from what the dealer states, even if they also ask follow-up questions. Use NEEDS_ACTION only when availability is not answered at all.',
    'An automatic acknowledgement such as "a mintaajánlatot hamarosan küldjük" (offer will be sent soon) has isRelevant=false.',
    '',
    'configMatch (about the car the dealer describes or offers):',
    '- EXACT: the dealer explicitly describes or offers a car where all attributes clearly match (Hungarian names like "panorámatető", "Titánszürke", "ALLGRIP", "6AT" count).',
    '- MISMATCH: clear evidence of a different trim/edition, engine, gearbox, drive, missing panorama roof, or another colour. Any colour other than the target colour IS a mismatch.',
    '- UNCLEAR: some attributes are not stated (e.g. colour given only as "metál"), or no specific car is described at all.',
    'If the offered car is a MISMATCH, availability must be NOT_AVAILABLE unless the dealer also confirms the exact target separately.',
    '',
    'Offers: extract prices in HUF as plain numbers. finalTotalGross is the total the buyer pays (e.g. "Teljes bruttó vételár"), including registration costs. Paid accessories are dealer-added extras with a price (e.g. "Gyárilag nem beszerelt extrafelszereltségek"). Discounts are negative lines ("kedvezmény"). Free items (0 Ft or "ajándék") go into freebies; a free winter tire/wheel set ("téli gumi", "téli kerékszett") sets includesWinterTires=true instead.',
    'All offer fields (estimatedDelivery, prices, accessories, winter tires, freebies, validity) describe ONLY the exact target configuration (configMatch EXACT or UNCLEAR). If the dealer only offers a different configuration (MISMATCH), set hasOffer=false, leave those fields empty/0/false and describe the alternative in configNotes instead.',
    'The PDF may be addressed to the customer; that is fine. Ignore quoted text of the customer\'s own original inquiry.',
    '',
    'dealerCode: pick the sending dealer from these candidates using the sender address, signature, company name, postal address, phone, website or email addresses mentioned in the text (ignore the customer\'s own details). Empty if unsure:',
    cands,
    '',
    '--- EMAIL ---',
    'From: ' + email.from,
    'Subject: ' + email.subject,
    'Date: ' + email.date.toISOString(),
    'Attachments: ' + (email.attachmentNames.join(', ') || 'none') + (email.pdfs.length ? ` (${email.pdfs.length} PDF attached below)` : ''),
    '',
    email.body,
  ].join('\n');
}

function analyzeEmail_(apiKey, email, candidates, today) {
  const parts = [{ text: buildPrompt_(email, candidates, today) }];
  email.pdfs.forEach((p) => parts.push({ inlineData: { mimeType: 'application/pdf', data: p.base64 } }));

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent';
  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA },
    }),
  };

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(url, request);
    const code = res.getResponseCode();
    if (code === 200) {
      const json = JSON.parse(res.getContentText());
      const cand = json.candidates && json.candidates[0];
      const text = cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('');
      if (!text) throw new Error('Gemini returned no content: ' + res.getContentText().slice(0, 300));
      return JSON.parse(text);
    }
    if (code !== 429 && code < 500) break;
    const delay = retryDelaySeconds_(res.getContentText()) || 10 * (attempt + 1);
    if (delay > 30 || attempt === 2) break; // e.g. daily quota exhausted: retry on a later run
    Utilities.sleep(delay * 1000);
  }
  const err = new Error('Gemini error: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  // Quota (429), billing/no credits (402) and server errors: pause and keep the email queued instead of failing it.
  err.retryable = [402, 429].indexOf(res.getResponseCode()) !== -1 || res.getResponseCode() >= 500;
  throw err;
}

function retryDelaySeconds_(body) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body || '');
  return m ? Math.ceil(Number(m[1])) : 0;
}
