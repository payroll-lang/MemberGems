/**
 * Notice.gs — the ESOP Exercise Notice.
 *
 * This reproduces "ESOP Exercise Form Notice Format.docx": the same headings,
 * the same sections A / B / C, the same wording, and the same placeholders,
 * so a signed PDF out of the portal reads as the approved form.
 *
 * Placeholder names are the document's own:
 *   {{Name}} {{Designation}} {{Member ID}} {{Member Address}} {{Nationality}}
 *   {{Pan Number}} {{Email ID}} {{Mobile Number}} {{Vested ESOPS}}
 *   {{Options to be Exercise}} {{Signing Date}} {{User Input 2}}   ← Place
 *
 * ONE ADDITION, flagged rather than hidden. The approved form states options
 * only, and says the Company will allot "the corresponding equity shares".
 * Under ESOP Plan 2022 one option converts to 3.6 shares, so the option count
 * alone does not tell the signer how many shares they are applying for.
 * Section B therefore also carries a grant-wise table and a share total. To
 * drop it, set NOTICE_SHOW_SHARES to false in Settings; to replace the whole
 * document with your own file, set NOTICE_TEMPLATE_DOC_ID.
 */


/** Accepted in a custom template. The document's own names come first. */
const NOTICE_PLACEHOLDERS = [
  'Name', 'Designation', 'Member ID', 'Member Address', 'Nationality',
  'Pan Number', 'Email ID', 'Mobile Number',
  'Vested ESOPS', 'Options to be Exercise', 'Signing Date', 'User Input 2',
  // available in addition
  'Shares To Be Allotted', 'Multiplier Summary', 'Grant Table',
  'Exercise Price', 'Total Exercise Amount', 'FMV', 'FMV Date',
  'Perquisite Amount', 'Tax Rate', 'Tax Amount',
  'Total Exercise Amount In Words', 'Perquisite Amount In Words', 'Tax Amount In Words',
  'Exercise UTR', 'Exercise Payment Date', 'Tax Mode', 'Fund Partner',
  'Tax UTR', 'Tax Payment Date',
  'DP Name', 'DP ID', 'Client ID', 'Demat Account Name', 'Demat Account Type',
  'Company Name', 'Plan Name', 'Window', 'Application ID', 'Payment Reference'
];


const Notice = (function () {


  /* ---------------- data ---------------- */


  function fields(app, emp, lines) {
    const grantsById = {};
    Repo.findByColumn(T.GRANTS, 'EmployeeID', Util.trim(app.EmployeeID))
      .forEach(g => { grantsById[Util.trim(g.GrantID)] = g; });


    const rows = lines.map(function (l) {
      const g = grantsById[Util.trim(l.GrantID)] || {};
      return {
        grantId: Util.trim(l.GrantID),
        planName: Util.trim(l.PlanName) || Util.trim(g.PlanName),
        multiplier: Util.num(l.Multiplier, Util.num(g.Multiplier, 1)) || 1,
        grantDate: Util.prettyDate(g.GrantDate),
        options: Util.num(l.OptionsExercised, 0),
        shares: Util.num(l.SharesAllotted, 0),
        price: Util.num(l.ExercisePrice, cfgNum('EXERCISE_PRICE', 1)),
        amount: Util.num(l.LineExerciseAmount, 0),
        perquisite: Util.num(l.LinePerquisite, 0)
      };
    });


    // "Total Vested Options as on date" — the whole vested balance, not just
    // the part being exercised.
    let totalVested = 0;
    Object.keys(grantsById).forEach(k => { totalVested += Util.num(grantsById[k].VestedOptions, 0); });


    const win = Repo.find(T.WINDOWS, w => Util.windowKey(w.WindowID) === Util.windowKey(app.WindowID));
    const multipliers = {};
    rows.forEach(r => { multipliers[r.planName] = r.multiplier; });


    return {
      'Name': Util.trim(emp.Name),
      'Designation': Util.trim(app.ApplicantDesignation) || Util.trim(emp.Designation),
      'Member ID': Util.trim(emp.EmployeeID),
      'Member Address': Util.trim(app.ApplicantAddress) || Util.trim(emp.Address),
      'Nationality': Util.trim(app.ApplicantNationality) || Util.trim(emp.Nationality) || 'Indian',
      'Pan Number': Util.trim(app.PANNumber) || Util.trim(emp.PAN),
      'Email ID': Util.trim(app.ApplicantEmail) || Domain.emailFor(emp),
      'Mobile Number': Util.trim(app.ApplicantMobile) || Util.trim(emp.Mobile),


      'Vested ESOPS': Util.count(totalVested),
      'Options to be Exercise': Util.count(app.TotalOptions),
      'Exercise Price': Util.inr2(Util.num(app.ExercisePrice, cfgNum('EXERCISE_PRICE', 1))),
      'Total Exercise Amount': Util.count(app.ExerciseAmount),
      'Shares To Be Allotted': Util.count(app.TotalShares),
      'Multiplier Summary': Object.keys(multipliers)
        .map(p => p + ': 1 option = ' + multipliers[p] + ' share' + (multipliers[p] === 1 ? '' : 's'))
        .join('; '),


      'FMV': Util.num(app.FMVValue, 0) ? Util.inr2(app.FMVValue) : '—',
      'FMV Date': Util.prettyDate(app.FMVDate) || '—',
      'Perquisite Amount': Util.inr(app.PerquisiteAmount),
      'Tax Rate': AppStore.effectiveRate(app) + '%',
      'Tax Amount': Util.inr(app.TaxAmount),


      // Amounts in words, for any template that wants them alongside the
      // figures. Standard practice on a document someone pays against.
      'Total Exercise Amount In Words': Util.inWords(app.ExerciseAmount),
      'Perquisite Amount In Words': Util.inWords(app.PerquisiteAmount),
      'Tax Amount In Words': Util.inWords(app.TaxAmount),


      'Exercise UTR': Util.trim(app.ExercisePaymentUTR) || '—',
      'Exercise Payment Date': Util.prettyDate(app.ExercisePaymentDate) || '—',
      'Tax Mode': Util.trim(app.TaxMode) === TAX_MODE.PARTNER
        ? 'Through a fund partner' : (Util.trim(app.TaxMode) ? 'Paid directly by me' : '—'),
      'Fund Partner': Util.trim(app.FundPartnerName) || '—',
      'Tax UTR': Util.trim(app.TaxPaymentUTR) || '—',
      'Tax Payment Date': Util.prettyDate(app.TaxPaymentDate) || '—',


      'DP Name': Util.trim(app.DematDPName),
      'DP ID': Util.trim(app.DematDPId),
      'Client ID': Util.trim(app.DematClientId),
      'Demat Account Name': Util.trim(app.DematAccountName),
      'Demat Account Type': Util.trim(app.DematAccountType),


      'Company Name': cfg('COMPANY_NAME'),
      'Plan Name': cfg('PLAN_NAME'),
      'Window': win ? Util.monthLabel(win.Label) : Util.windowKey(app.WindowID),
      'Application ID': Util.trim(app.AppID),
      'Payment Reference': Domain.paymentReference(emp),
      'Signing Date': Util.prettyDate(app.NoticeSignedAt) || Util.prettyDate(new Date()),
      'User Input 2': Util.trim(app.NoticePlace),


      _rows: rows,
      _signatureName: Util.trim(app.NoticeSignatureName),
      // Kept raw — Sheets hands this back as a Date, and trimming it to a
      // string first produces JavaScript's own format, which prettyStamp
      // then cannot reliably parse back.
      _signedAt: app.NoticeSignedAt,
      _place: Util.trim(app.NoticePlace)
    };
  }


  /* ---------------- pieces ---------------- */


  function kvTable(pairs) {
    return '<table class="grid"><thead><tr><th>Particulars</th><th>Details</th></tr></thead><tbody>' +
      pairs.map(p => '<tr><td class="pt">' + Util.escapeHtml(p[0]) + '</td><td class="pv">' +
        (p[1] ? Util.escapeHtml(p[1]).replace(/\n/g, '<br>') : '<span class="blank"></span>') +
        '</td></tr>').join('') +
      '</tbody></table>';
  }


  /** COMPANY_BANK_DETAILS is maintained as "Label: value" lines. */
  function bankTable() {
    const lines = String(cfg('COMPANY_BANK_DETAILS')).split(/\n+/).map(s => s.trim()).filter(Boolean);
    const pairs = [], loose = [];
    lines.forEach(function (line) {
      const at = line.indexOf(':');
      if (at > 0) pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
      else loose.push(line);
    });
    return { table: pairs.length ? kvTable(pairs) : '', extra: loose };
  }


  function grantTableHtml(rows) {
    const multi = rows.some(r => Math.abs(r.multiplier - 1) > 1e-9);
    return '<table class="grid"><thead><tr>' +
      '<th>Grant ID</th><th>Plan</th><th class="n">Options</th>' +
      (multi ? '<th class="n">Conversion</th><th class="n">Equity shares</th>' : '<th class="n">Equity shares</th>') +
      '<th class="n">Exercise amount</th></tr></thead><tbody>' +
      rows.map(r => '<tr>' +
        '<td>' + Util.escapeHtml(r.grantId) + (r.grantDate ? '<br><span class="dim">granted ' + Util.escapeHtml(r.grantDate) + '</span>' : '') + '</td>' +
        '<td>' + Util.escapeHtml(r.planName) + '</td>' +
        '<td class="n">' + Util.count(r.options) + '</td>' +
        (multi ? '<td class="n">× ' + r.multiplier + '</td>' : '') +
        '<td class="n">' + Util.count(r.shares) + '</td>' +
        '<td class="n">' + Util.inr(r.amount) + '</td>' +
        '</tr>').join('') +
      '</tbody><tfoot><tr>' +
      '<td colspan="2">Total</td>' +
      '<td class="n">' + Util.count(rows.reduce((a, r) => a + r.options, 0)) + '</td>' +
      (multi ? '<td class="n"></td>' : '') +
      '<td class="n">' + Util.count(rows.reduce((a, r) => a + r.shares, 0)) + '</td>' +
      '<td class="n">' + Util.inr(rows.reduce((a, r) => a + r.amount, 0)) + '</td>' +
      '</tr></tfoot></table>';
  }


  function grantTableText(rows) {
    return rows.map(r => r.grantId + ' (' + r.planName + '): ' + Util.count(r.options) +
      ' options × ' + r.multiplier + ' = ' + Util.count(r.shares) + ' shares, ' +
      Util.inr(r.amount)).join('\n');
  }


  function signatureBlock(f) {
    if (!f._signedAt) {
      return '<div class="sig pending">' +
        '<div class="siglabel">Signature</div>' +
        '<p class="dim">Not yet signed. Type your full name in the portal to sign this notice.</p>' +
        '</div>';
    }
    return '<div class="sig">' +
      '<div class="sigrow"><span class="k">Name:</span><span class="v">' + Util.escapeHtml(f['Name']) + '</span></div>' +
      '<div class="sigrow sigline"><span class="k">Signature:</span>' +
      '<span class="v"><span class="signed">' + Util.escapeHtml(f._signatureName) + '</span></span></div>' +
      '<div class="sigrow"><span class="k">Date:</span><span class="v">' + Util.escapeHtml(f['Signing Date']) + '</span></div>' +
      '<div class="sigrow"><span class="k">Place:</span><span class="v">' + Util.escapeHtml(f._place || '—') + '</span></div>' +
      '<p class="attest">Signed electronically through the ' + Util.escapeHtml(cfg('COMPANY_NAME')) +
      ' ESOP Exercise Portal on ' + Util.escapeHtml(Util.prettyStamp(f._signedAt)) +
      ' by the holder of employee code ' +
      Util.escapeHtml(f['Member ID']) + ', authenticated by their portal password. ' +
      'Signature reference ' + Util.escapeHtml(f['Application ID']) + '.</p>' +
      '</div>';
  }


  /* ---------------- the default body: the approved form ---------------- */


  function defaultBody(f) {
    const bank = bankTable();
    const showShares = String(cfg('NOTICE_SHOW_SHARES', 'true')).toLowerCase() !== 'false';
    const former = Util.trim(cfg('COMPANY_FORMER_NAME'));
    const address = Util.trim(cfg('COMPANY_ADDRESS'));


    // No logo on the notice. It is a legal instrument addressed TO the company
    // and signed by the participant; a company crest at its head reads as the
    // company's own document. The logo stays on the portal screens and emails.
    return '' +
      '<h1>ESOP - EXERCISE NOTICE</h1>' +


      '<div class="to">' +
      '<p>To,<br><b>' + Util.escapeHtml(cfg('COMPANY_NAME')) + '</b>' +
      (former ? '<br>(' + Util.escapeHtml(former.replace(/^\(|\)$/g, '')) + ')' : '') +
      (address ? '<br>Add: ' + Util.escapeHtml(address).replace(/\n/g, '<br>') : '') +
      '</p></div>' +


      '<p class="subject"><b>Subject: Exercise of vested employee stock options</b></p>' +


      '<p>Dear Sir/Madam,</p>' +


      '<p>Having understood the terms and conditions of options granted under ‘Employees’ Stock Option Plan’ ' +
      '(“ESOP Scheme/Plan”), I hereby apply to exercise the vested options which were granted to me by the ' +
      'Company and also request the Company to allot and credit the appropriate and relevant type of shares to ' +
      'my demat account. I hereby agree to accept the shares applied for or the number of shares as may be ' +
      'allotted to me, subject to the terms and conditions of the ESOP Scheme/plan of the Company. I bind myself ' +
      'to the terms and conditions of the ESOP Scheme/Plan of the Company. I note that the Company has the ' +
      'absolute right to accept or reject this application in whole or in part without assigning any reason ' +
      'whatsoever. I hereby irrevocably authorise the Company to carry out its duties in connection with this ' +
      'application. Furnishing herein below all the required details:</p>' +


      '<h2>A. PERSONAL DETAILS (PLEASE PRINT IN BLOCK LETTERS):</h2>' +
      kvTable([
        ['Name of the Applicant', f['Name']],
        ['Designation', f['Designation']],
        ['Employee Code', f['Member ID']],
        ['Address', f['Member Address']],
        ['Nationality', f['Nationality']],
        ['PAN', f['Pan Number']],
        ['Email ID', f['Email ID']],
        ['Mobile Number', f['Mobile Number']]
      ]) +


      '<h2>B. DETAILS OF OPTIONS EXERCISED</h2>' +
      '<ul class="plain">' +
      '<li>Total Vested Options as on date: <b>' + Util.escapeHtml(f['Vested ESOPS']) + '</b> Units</li>' +
      '<li>Number of Options proposed to be Exercised: <b>' + Util.escapeHtml(f['Options to be Exercise']) + '</b> Units ' +
      '<span class="dim">(Please ensure options should be in multiples of ' + Domain.lotSize() +
      ' and less than the number of vested options)</span></li>' +
      '<li>Exercise Price per Option: <b>₹ ' + Util.escapeHtml(f['Exercise Price'].replace(/^₹/, '')) + '</b></li>' +
      '<li>Total Exercise Amount Payable: <b>₹ ' + Util.escapeHtml(f['Total Exercise Amount']) + '/-</b>' +
      ' <span class="words">(' + Util.escapeHtml(f['Total Exercise Amount In Words']) + ')</span></li>' +
      (showShares
        ? '<li>Equity shares to be allotted on conversion: <b>' + Util.escapeHtml(f['Shares To Be Allotted']) + '</b>' +
          (f['Multiplier Summary'] ? ' <span class="dim">(' + Util.escapeHtml(f['Multiplier Summary']) + ')</span>' : '') +
          '</li>'
        : '') +
      '</ul>' +


      (showShares && f._rows.length ? '<div class="sub">Grant-wise breakdown</div>' + grantTableHtml(f._rows) : '') +


      '<p>I hereby agree to pay the total exercise amount along with all applicable taxes, duties, and statutory ' +
      'levies within the prescribed exercise period in accordance with the ESOP Plan.</p>' +


      '<p>I request the Company to allot and credit the corresponding equity shares and/or such adjustment to the ' +
      'fraction number of shares which may come after conversion of options to equity shares to my demat account ' +
      'upon receipt of the applicable exercise consideration and taxes.</p>' +


      '<h2>C. COMPANY BANK DETAILS FOR PAYMENT OF EXERCISE AMOUNT</h2>' +
      '<p>Members are required to transfer the total Exercise Amount (plus applicable taxes) to the following ' +
      'bank account:</p>' +
      bank.table +
      (bank.extra.length ? '<p>' + bank.extra.map(Util.escapeHtml).join('<br>') + '</p>' : '') +


      '<p class="sub2"><b>Important Instructions:</b></p>' +
      '<ul>' +
      '<li>Payment reference must mention: “' + Util.escapeHtml(f['Payment Reference']) + '”</li>' +
      '<li>Proof of payment (UTR number) must be shared with the ESOP team immediately after transfer.</li>' +
      '<li>Shares shall be allotted only upon confirmation of receipt of funds, applicable taxes ' +
      '(e.g. perquisite income tax, etc.), and necessary information and subject to all necessary approval from ' +
      'the Board/committee and all other authorities wherever required.</li>' +
      '<li>Incomplete or delayed payments may result in lapse of exercise request as per ESOP Plan terms.</li>' +
      '</ul>' +


      signatureBlock(f);
  }


  /* ---------------- custom template ---------------- */


  function applyTemplate(text, f) {
    let out = String(text);
    NOTICE_PLACEHOLDERS.forEach(function (key) {
      const value = key === 'Grant Table' ? grantTableText(f._rows)
        : (f[key] === undefined ? '' : String(f[key]));
      const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\{\\{\\s*' + safe + '\\s*\\}\\}', 'gi'), value);
    });
    return out;
  }


  function customBody(f) {
    const docId = Util.trim(cfg('NOTICE_TEMPLATE_DOC_ID'));
    if (!docId) return null;
    let text;
    try {
      text = DocumentApp.openById(docId).getBody().getText();
    } catch (e) {
      console.error('notice template unreadable: ' + e);
      return null;
    }
    if (!Util.trim(text)) return null;
    const filled = Util.escapeHtml(applyTemplate(text, f))
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');
    return '<div class="custom"><p>' + filled + '</p></div>' + signatureBlock(f);
  }


  /* ---------------- styling ---------------- */


  const CSS =
    'body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:11pt;color:#14211c;line-height:1.5;margin:0}' +
    '.doc{max-width:780px;margin:0 auto}' +
    'h1{font-size:15pt;font-weight:700;margin:0 0 16px;text-align:center;letter-spacing:.02em;text-decoration:underline}' +
    'h2{font-size:11pt;font-weight:700;margin:22px 0 8px}' +
    '.sub{font-size:9.5pt;font-weight:700;color:#4a5b53;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.06em}' +
    '.sub2{margin:16px 0 4px}' +
    'p{margin:9px 0;text-align:justify}' +
    '.to p{text-align:left;margin:0 0 12px}' +
    '.subject{margin:14px 0}' +
    'ul{margin:8px 0;padding-left:22px}' +
    'ul.plain{list-style:none;padding-left:0}' +
    'ul.plain li{margin:5px 0}' +
    'li{margin:4px 0;text-align:left}' +
    'table.grid{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:10.5pt}' +
    'table.grid th{text-align:left;font-weight:700;padding:7px 10px;border:1px solid #14211c;background:#f0f2ec}' +
    'table.grid td{padding:7px 10px;border:1px solid #c2cabe;vertical-align:top}' +
    'table.grid tfoot td{font-weight:700;background:#f6f7f3}' +
    'table.grid td.pt{width:38%;color:#4a5b53}' +
    'table.grid td.pv{font-weight:600}' +
    'table.grid .n,table.grid th.n{text-align:right}' +
    '.words{font-style:italic;color:#555;font-size:.92em}' +
    '.crest{text-align:center;margin:0 0 14px}' +
    '.crest img{height:56px;width:auto}' +
    '.blank{display:inline-block;min-width:150px;border-bottom:1px dotted #7c8b83}' +
    '.dim{color:#5a6b63;font-weight:400;font-size:9.5pt}' +
    '.sig{margin:30px 0 0;padding:16px 18px;border:1px solid #14211c}' +
    '.sig.pending{border-style:dashed;border-color:#a8741a}' +
    '.siglabel{font-size:8.5pt;letter-spacing:.09em;text-transform:uppercase;color:#5a6b63}' +
    '.sigrow{display:flex;gap:10px;margin:7px 0;align-items:baseline}' +
    '.sigrow .k{min-width:88px;color:#4a5b53}' +
    '.sigrow .v{font-weight:600}' +
    /* The signature must not read like the printed name above it.
     *
     * The old rule named only Segoe Script and Bradley Hand. Neither is
     * installed on most machines, and the generic `cursive` fallback resolved
     * to nothing distinctive — so the signature inherited the bold sans of
     * the row and looked identical to the Name field.
     *
     * "Dancing Script" is loaded as a web font by the page, so the on-screen
     * notice is deterministic. Everything after it is a fallback chain that
     * ends in an ITALIC SERIF, so even where no script face exists at all the
     * signature is still visibly a different hand from the name.
     */
    '.signed{' +
      'font-family:"Dancing Script","Segoe Script","Brush Script MT","Lucida Handwriting",' +
      '"Apple Chancery",cursive,Georgia,serif;' +
      'font-style:italic;font-weight:500;font-size:23pt;line-height:1.1;' +
      'color:#14342a;letter-spacing:.01em;' +
    '}' +
    /* A ruled line under it, as on the paper form. */
    '.sigrow.sigline{align-items:flex-end;margin:2px 0 10px}' +
    '.sigrow.sigline .v{border-bottom:1px solid #14211c;padding:0 26px 3px 2px;min-width:230px}' +
    '.attest{margin:12px 0 0;font-size:8.5pt;color:#5a6b63;text-align:left;line-height:1.45}' +
    '.custom p{text-align:justify}';


  /** Prefix every selector so the notice cannot restyle the portal page. */
  function scopeCss(css, prefix) {
    return css.replace(/(^|\})\s*([^{}]+)\s*\{/g, function (match, close, selectors) {
      const scoped = selectors.split(',').map(function (s) {
        const sel = s.trim();
        if (!sel) return sel;
        return sel === 'body' ? prefix : prefix + ' ' + sel;
      }).join(', ');
      return close + scoped + '{';
    });
  }


  /* ---------------- render ---------------- */


  function html(app, emp, lines) {
    const f = fields(app, emp, lines);
    // The signature face is requested here too, for the standalone document
    // and the PDF built from it. Whether Google's HTML-to-PDF conversion
    // fetches a web font is not guaranteed, which is why the .signed rule
    // ends its fallback chain in an italic serif — the signature stays
    // visibly distinct from the printed name even if the font never arrives.
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500;600&display=swap">' +
      '<style>' + CSS + '</style></head>' +
      '<body><div class="doc">' + (customBody(f) || defaultBody(f)) + '</div></body></html>';
  }


  function bodyHtml(app, emp, lines) {
    const f = fields(app, emp, lines);
    return '<style>' + scopeCss(CSS, '.esop-notice') + '</style>' +
      '<div class="esop-notice"><div class="doc">' + (customBody(f) || defaultBody(f)) + '</div></div>';
  }


  /** Render the signed notice to PDF and file it in the application folder. */
  function generatePdf(app, emp, lines) {
    const blob = Utilities.newBlob(html(app, emp, lines), 'text/html', 'notice.html')
      .getAs('application/pdf')
      .setName('Exercise Notice — ' + Util.trim(app.AppID) + '.pdf');
    const folder = Files.applicationFolder(app, emp);
    const it = folder.getFiles();
    while (it.hasNext()) {
      const file = it.next();
      if (file.getName().indexOf('Exercise Notice — ') === 0) file.setTrashed(true);
    }
    return folder.createFile(blob).getId();
  }


  return {
    bodyHtml: bodyHtml,
    html: html,
    generatePdf: generatePdf,
    fields: fields,
    placeholders: NOTICE_PLACEHOLDERS
  };
})();


