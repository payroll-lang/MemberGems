/**
 * Mailer.gs — every stage email in one file.
 *
 * Sends are logged to the EmailLog tab and never throw: a failed email must
 * not roll back a saved application. Set EMAILS_ENABLED=false in Config while
 * testing to log without sending.
 */


const Mailer = (function () {


  function templates() {
    const company = cfg('COMPANY_NAME');
    const portal = Util.trim(cfg('PORTAL_URL'));
    const support = Util.trim(cfg('SUPPORT_EMAIL'));


    const signoff =
      '<p style="margin:22px 0 0">— ESOP team, ' + Util.escapeHtml(company) + '</p>' +
      (support ? '<p style="margin:4px 0 0;color:#5a6b63;font-size:13px">Questions: ' +
        '<a href="mailto:' + Util.escapeHtml(support) + '">' + Util.escapeHtml(support) + '</a></p>' : '');


    const link = portal
      ? '<p style="margin:18px 0"><a href="' + Util.escapeHtml(portal) + '" style="background:#1b6046;color:#fff;padding:10px 18px;border-radius:2px;text-decoration:none;font-weight:600">Open the ESOP portal</a></p>'
      : '';


    return {


      account_ready: d => ({
        subject: 'Your ' + company + ' ESOP portal login',
        body:
          p('Hello ' + d.name + ',') +
          p('A login has been created for you on the ' + company + ' ESOP Exercise Portal.') +
          kv([
            ['User ID', d.userId],
            ['One-time code', '<b style="font-size:20px;letter-spacing:.12em">' + d.code + '</b>'],
            ['Valid for', d.minutes + ' minutes']
          ]) +
          p('Sign in with your user ID, choose <i>Set or reset password</i>, enter the code above and pick a password of your own. The code works once.') +
          link +
          p('If the code has expired by the time you get to it, use <i>Forgot password</i> on the sign-in screen to have a new one sent.')
      }),


      reset_code: d => ({
        subject: 'Your ESOP portal one-time code',
        body:
          p('Hello ' + d.name + ',') +
          p('Here is the one-time code to set a new password on your ESOP portal account.') +
          kv([
            ['User ID', d.userId],
            ['One-time code', '<b style="font-size:20px;letter-spacing:.12em">' + d.code + '</b>'],
            ['Valid for', d.minutes + ' minutes']
          ]) +
          p('If you did not ask for this, you can ignore this email — your current password still works.')
      }),


      password_changed: d => ({
        subject: 'Your ESOP portal password was changed',
        body:
          p('Hello ' + d.name + ',') +
          p('The password on ESOP portal account <b>' + d.userId + '</b> was changed on ' + Util.stamp() + '. Every other signed-in session has been ended.') +
          p('If this was not you, contact the ESOP team immediately.')
      }),


      window_open: d => ({
        subject: 'ESOP exercise window open — ' + d.windowLabel,
        body:
          p('Hello ' + d.name + ',') +
          p('The <b>' + d.windowLabel + '</b> exercise window is open from ' + d.openDate + ' to ' + d.closeDate + '.') +
          kv([
            ['Options available to exercise', Util.count(d.available)],
            ['Exercise price', Util.inr2(d.exercisePrice) + ' per option'],
            ['Tax payment due by', d.taxDueDate]
          ]) +
          p('You can start an application, save it part-finished and come back to it any time before the window closes.') +
          link
      }),


      options_saved: d => ({
        subject: 'Options recorded — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('We have recorded the options you wish to exercise in the ' + d.windowLabel + ' window.') +
          kv([
            ['Application', d.appId],
            ['Total options', Util.count(d.totalOptions)],
            ['Equity shares on conversion', Util.count(d.totalShares)],
            ['Exercise amount payable', payable(d.exerciseAmount)]
          ]) +
          p('Next: complete your applicant details and upload your demat client master report (CML) and PAN, then transfer the exercise amount and upload the payment proof.') +
          bank('Exercise amount — transfer to', cfg('COMPANY_BANK_DETAILS')) +
          (d.paymentReference
            ? p('Quote this reference on the transfer: <b>' + Util.escapeHtml(d.paymentReference) + '</b>')
            : '') +
          p('Your tax will be computed on the fair market value of the trading day <i>before</i> the day you pay the exercise amount, so the transfer date matters.') +
          link
      }),


      price_load_failed: d => ({
        subject: 'ESOP portal could not load the ' + d.symbol + ' share price',
        body:
          p('The daily job could not load the latest opening and closing price for <b>' +
            Util.escapeHtml(d.symbol) + '</b> from NSE.') +
          p('Until a price is on record, nobody who pays the exercise amount can be priced, and the portal will ' +
            'tell them so rather than compute a wrong figure.') +
          blockquote(d.detail) +
          p('Enter the two prices by hand on the Share price screen — the exchange bhavcopy is the auditable ' +
            'source in any case. If this repeats every day, NSE is refusing requests from Google\'s servers and ' +
            'manual entry should become the routine.') +
          link
      }),


      demat_saved: d => ({
        subject: 'Demat and PAN details received — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your demat account details and PAN have been received against application ' + d.appId + '.') +
          kv([
            ['Depository participant', d.dpName],
            ['DP ID', d.dpId],
            ['Client ID', d.clientId],
            ['PAN', d.pan]
          ]) +
          p('These will be verified by the ESOP team against the CML you uploaded. Shares will be credited to exactly this account, so tell us straight away if anything above is wrong.') +
          link
      }),


      exercise_payment_received: d => ({
        subject: 'Exercise payment recorded — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your exercise payment details have been recorded and your perquisite has been priced.') +
          kv([
            ['Application', d.appId],
            ['Options exercised', Util.count(d.totalOptions)],
            ['Equity shares on conversion', Util.count(d.totalShares)],
            ['Exercise amount paid', Util.inr(d.exerciseAmount)],
            ['UTR', d.utr],
            ['Payment date', d.paymentDate],
            ['FMV applied (' + d.fmvDate + ')', Util.inr2(d.fmv) + ' per share'],
            ['Perquisite value', Util.inr(d.perquisite)],
            ['Tax rate applied', d.taxRate + '%'],
            ['Tax payable', payable(d.tax)],
            ['Tax due by', '<b>' + d.taxDueDate + '</b>']
          ]) +
          p('The FMV above is the average of the opening and closing price on ' + d.fmvDate +
            ', the trading day before your payment date. The perquisite is that FMV applied to the ' +
            Util.count(d.totalShares) + ' shares you receive, less the exercise amount you paid.') +
          p('Next: pay the tax amount and upload the proof, or choose to route it through one of our fund partners.') +
          bank('Tax amount — transfer to', cfg('TAX_BANK_DETAILS')) +
          link
      }),


      tax_reminder: d => ({
        subject: 'Reminder: ESOP tax payment due ' + d.taxDueDate + ' — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('The tax on your ' + d.windowLabel + ' exercise is due by <b>' + d.taxDueDate + '</b>' +
            (d.daysLeft === 0 ? ' — that is today.' : ' — ' + d.daysLeft + ' day' + (d.daysLeft === 1 ? '' : 's') + ' from now.')) +
          kv([
            ['Application', d.appId],
            ['Perquisite value', Util.inr(d.perquisite)],
            ['Tax payable', payable(d.tax)]
          ]) +
          p('Pay the amount and upload the UTR and payment date in the portal, or select a fund partner to pay it on your behalf.') +
          link
      }),


      tax_payment_received: d => ({
        subject: 'Tax payment recorded — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your tax payment details have been recorded against application ' + d.appId + '.') +
          kv([
            ['Tax amount', Util.inr(d.amount)],
            ['UTR', d.utr],
            ['Payment date', d.paymentDate]
          ]) +
          p('Next: read and sign the exercise notice, then submit the application for verification.') +
          link
      }),


      partner_assigned_employee: d => ({
        subject: 'Fund partner selected — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('You have chosen <b>' + d.partner + '</b> to pay the tax on application ' + d.appId + ' on your behalf. They have been notified.') +
          kv([
            ['Tax amount', Util.inr(d.tax) + ''],
            ['Tax due by', d.taxDueDate]
          ]) +
          p('The partner will enter their payment details in the portal. You will be emailed when they do, and the ESOP team will then verify it. You remain responsible for the tax reaching us by the due date.') +
          link
      }),


      partner_assigned_partner: d => ({
        subject: 'New ESOP tax payment request — ' + d.appId,
        body:
          p('Hello ' + d.partner + ' team,') +
          p('An employee has asked you to pay the tax on their ESOP exercise.') +
          kv([
            ['Request', d.requestId],
            ['Application', d.appId],
            ['Employee', d.employeeName + ' (' + d.employeeId + ')'],
            ['Options exercised', Util.count(d.totalOptions)],
            ['Perquisite value', Util.inr(d.perquisite)],
            ['Tax amount to be paid', payable(d.tax)],
            ['Due by', '<b>' + d.taxDueDate + '</b>']
          ]) +
          bank('Transfer to', cfg('TAX_BANK_DETAILS')) +
          p('Sign in to the portal with your fund partner login to record <b>the demat account</b> ' +
            'the shares are to be allotted into, then the UTR, payment date and payment proof. ' +
            'The demat account is needed first — the shares cannot be allotted without it.') +
          link
      }),


      partner_demat_set_employee: d => ({
        subject: 'Where your shares will be credited — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('<b>' + d.partner + '</b> has confirmed the demat account for your ESOP exercise ' +
            d.appId + '. Your ' + Util.count(d.totalShares) + ' equity shares will be credited here:') +
          kv([
            ['Depository participant', d.dpName],
            ['Account type', d.accountType],
            ['DP ID', '<b>' + d.dpId + '</b>'],
            ['Client ID', '<b>' + d.clientId + '</b>'],
            ['Account holder', d.accountName || '—']
          ]) +
          p('<b>Please check these against your own records with ' + d.partner + '.</b> Shares are ' +
            'credited to exactly this account, and a wrong identifier is difficult to unwind after ' +
            'allotment. Tell the ESOP team straight away if anything looks wrong.') +
          p('This replaces any demat account you entered yourself earlier in the application, ' +
            'because you chose ' + d.partner + ' to fund the tax and the shares are held in the ' +
            'account you opened with them.') +
          link
      }),


      partner_declined_employee: d => ({
        subject: d.partner + ' could not take your funding request — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('<b>' + d.partner + '</b> has declined to fund the tax for your ESOP exercise ' + d.appId + '.') +
          kv([['Their reason', Util.escapeHtml(d.reason)]]) +
          p('<b>Nothing is lost.</b> Your options, payment and notice are as you left them. Open the ' +
            'tax step and either choose a different fund partner or pay the tax of ' + Util.inr(d.taxAmount) +
            ' yourself. Any demat account entered on your behalf has been put back to the one you gave.') +
          p('The tax is still due by ' + d.taxDueDate + ' whichever route you take.') +
          link
      }),


      partner_declined_admin: d => ({
        subject: d.partner + ' declined a funding request — ' + d.appId,
        body:
          p('<b>' + d.partner + '</b> has declined a fund-partner request. The participant has been told ' +
            'and can choose another route.') +
          kv([
            ['Application', d.appId],
            ['Employee', d.employeeName + ' (' + d.employeeId + ')'],
            ['Tax to fund', Util.inr(d.taxAmount)],
            ['Reason given', Util.escapeHtml(d.reason)]
          ])
      }),


      partner_demat_set_admin: d => ({
        subject: 'Allotment account set by ' + d.partner + ' — ' + d.appId,
        body:
          p('<b>' + d.partner + '</b> has recorded the demat account for an application they are funding.') +
          kv([
            ['Application', d.appId],
            ['Employee', d.employeeName + ' (' + d.employeeId + ')'],
            ['Shares to allot', Util.count(d.totalShares)],
            ['Account type', d.accountType],
            ['DP ID / Client ID', '<b>' + d.dpId + ' / ' + d.clientId + '</b>'],
            ['Account holder', d.accountName || '—']
          ]) +
          p('This is now the allotment account on the application, replacing whatever the ' +
            'participant entered themselves. The demat section has been reset to <b>pending</b> ' +
            'so it is re-checked before approval.') +
          link
      }),


      partner_payment_fed_employee: d => ({
        subject: 'Your fund partner has paid the tax — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('<b>' + d.partner + '</b> has recorded the tax payment on your behalf.') +
          kv([
            ['Tax amount', Util.inr(d.amount)],
            ['UTR', d.utr],
            ['Payment date', d.paymentDate]
          ]) +
          p('Next: read and sign the exercise notice, then submit your application for verification.') +
          link
      }),


      partner_payment_fed_admin: d => ({
        subject: 'Fund partner payment to verify — ' + d.appId,
        body:
          p('A fund partner has fed a tax payment for verification.') +
          kv([
            ['Partner', d.partner],
            ['Application', d.appId],
            ['Employee', d.employeeName + ' (' + d.employeeId + ')'],
            ['Amount', Util.inr(d.amount)],
            ['UTR', d.utr],
            ['Payment date', d.paymentDate]
          ]) +
          link
      }),


      notice_signed: d => ({
        subject: 'Exercise notice signed — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your exercise notice has been signed electronically and filed in your document folder.') +
          kv([
            ['Signed as', d.signatureName],
            ['Signed at', d.signedAt],
            ['Options exercised', Util.count(d.totalOptions)]
          ]) +
          p('A PDF copy is attached for your records. Submit the application when you are ready.') +
          link
      }),


      application_submitted_employee: d => ({
        subject: 'Application submitted — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your exercise application for the ' + d.windowLabel + ' window has been submitted for verification.') +
          kv([
            ['Application', d.appId],
            ['Options exercised', Util.count(d.totalOptions)],
            ['Exercise amount', Util.inr(d.exerciseAmount)],
            ['Perquisite value', Util.inr(d.perquisite)],
            ['Tax', Util.inr(d.tax)]
          ]) +
          p('The ESOP team will verify your demat details, PAN, payment proofs and signed notice. You will be emailed once it is approved, or if anything needs correcting.') +
          link
      }),


      application_submitted_admin: d => ({
        subject: 'ESOP application to verify — ' + d.appId + ' (' + d.employeeName + ')',
        body:
          p('An exercise application has been submitted for verification.') +
          kv([
            ['Application', d.appId],
            ['Employee', d.employeeName + ' (' + d.employeeId + ')'],
            ['Window', d.windowLabel],
            ['Options', Util.count(d.totalOptions)],
            ['Exercise amount', Util.inr(d.exerciseAmount)],
            ['Perquisite', Util.inr(d.perquisite)],
            ['Tax', Util.inr(d.tax)],
            ['Tax route', d.taxMode]
          ]) +
          link
      }),


      application_sent_back: d => ({
        subject: 'Action needed on your ESOP application — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('The ESOP team has reviewed application ' + d.appId + ' and needs something corrected before it can be approved.') +
          (d.sections && d.sections.length
            ? '<p style="margin:14px 0 6px"><b>Sections to correct</b></p><ul style="margin:0 0 14px;padding-left:20px">' +
              d.sections.map(s => '<li>' + Util.escapeHtml(s) + '</li>').join('') + '</ul>'
            : '') +
          (d.remarks ? blockquote(d.remarks) : '') +
          p('Open the portal, correct the section and submit again. Nothing else you have entered is lost.') +
          link
      }),


      application_approved: d => ({
        subject: 'Exercise application approved — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Your exercise application has been verified and approved.') +
          kv([
            ['Application', d.appId],
            ['Options exercised', Util.count(d.totalOptions)],
            ['Exercise amount', Util.inr(d.exerciseAmount)],
            ['Perquisite value', Util.inr(d.perquisite)],
            ['Tax accounted', Util.inr(d.tax)],
            ['Demat account', d.dpId + ' / ' + d.clientId]
          ]) +
          (d.remarks ? blockquote(d.remarks) : '') +
          p('The shares will be allotted and credited to the demat account above. The perquisite and the tax will be reflected in your payroll records and in Form 12BA for the year.') +
          link
      }),


      application_rejected: d => ({
        subject: 'Exercise application closed — ' + d.appId,
        body:
          p('Hello ' + d.name + ',') +
          p('Application ' + d.appId + ' has been closed without being processed.') +
          (d.remarks ? blockquote(d.remarks) : '') +
          p('Your options have been released back to your available balance. Contact the ESOP team if you believe this is a mistake.')
      }),


      window_closing: d => ({
        subject: 'ESOP window closes ' + d.closeDate + ' — application not yet submitted',
        body:
          p('Hello ' + d.name + ',') +
          p('Your ' + d.windowLabel + ' exercise application is still a draft and the window closes on <b>' + d.closeDate + '</b>' +
            (d.daysLeft === 0 ? ' — today.' : ', ' + d.daysLeft + ' day' + (d.daysLeft === 1 ? '' : 's') + ' from now.')) +
          kv([
            ['Application', d.appId],
            ['Still to do', d.pending]
          ]) +
          p('A draft that is not submitted before the window closes does not carry over — the options return to your available balance and you would need to start again in the next window.') +
          link
      })
    };


    /* --- small HTML helpers --- */
    function p(html) {
      return '<p style="margin:12px 0;line-height:1.6">' + html + '</p>';
    }
    function kv(pairs) {
      return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;font-size:14px">' +
        pairs.map(function (x) {
          return '<tr>' +
            '<td style="padding:6px 18px 6px 0;color:#5a6b63;vertical-align:top;white-space:nowrap">' + Util.escapeHtml(x[0]) + '</td>' +
            '<td style="padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' + x[1] + '</td>' +
            '</tr>';
        }).join('') + '</table>';
    }
    /**
     * A figure someone is being asked to pay: the amount, and the amount in
     * words underneath it. The words are what catch a misread lakh before
     * the money moves.
     */
    function payable(n) {
      return '<b>' + Util.inr(n) + '</b>' +
        '<div style="font-family:Georgia,serif;font-style:italic;font-size:12px;color:#5a6b63;margin-top:2px">' +
        Util.escapeHtml(Util.inWords(n)) + '</div>';
    }
    function bank(title, details) {
      if (!Util.trim(details)) return '';
      return '<div style="margin:16px 0;padding:12px 14px;border:1px solid #c2cabe;border-left:3px solid #1b6046;background:#f6f7f3">' +
        '<div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6b63;margin-bottom:6px">' + Util.escapeHtml(title) + '</div>' +
        '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre-line">' + Util.escapeHtml(details) + '</div>' +
        '</div>';
    }
    function blockquote(text) {
      return '<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #a8741a;background:#f7efdd">' +
        '<div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6b63;margin-bottom:6px">Remarks from the ESOP team</div>' +
        '<div style="white-space:pre-line">' + Util.escapeHtml(text) + '</div></div>';
    }
  }


  /**
   * `hasLogo` says whether a logo is being attached to this message.
   *
   * Referenced as cid:logo rather than as a data URI: Gmail, Outlook and most
   * other clients strip data: images, so an inline attachment is the only
   * form that actually displays.
   */
  function wrap(subject, bodyHtml, hasLogo) {
    const company = Util.escapeHtml(cfg('COMPANY_NAME'));
    return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#14211c;max-width:620px">' +
      '<div style="border-bottom:1px solid #c2cabe;padding-bottom:10px;margin-bottom:18px">' +
      (hasLogo ? '<img src="cid:logo" alt="" style="height:34px;width:auto;display:block;margin-bottom:9px">' : '') +
      '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7c8b83">' + company + ' · ESOP</div>' +
      '<div style="font-size:19px;margin-top:4px">' + Util.escapeHtml(subject) + '</div>' +
      '</div>' + bodyHtml +
      '<div style="margin-top:26px;padding-top:12px;border-top:1px solid #dde2da;font-size:11.5px;color:#7c8b83;line-height:1.6">' +
      'Sent by the ' + company + ' ESOP Exercise Portal. Amounts shown are computed from the data on record at the time of sending; ' +
      'payroll figures of record prevail. Do not reply to this address.' +
      '</div></div>';
  }


  /**
   * Send one templated email. Never throws.
   * attachments: optional array of Drive file IDs.
   */
  function send(templateName, to, data, options) {
    const opts = options || {};
    const recipient = Util.trim(to);
    let subject = '(' + templateName + ')';
    try {
      const tpls = templates();
      const tpl = tpls[templateName];
      if (!tpl) throw new Error('Unknown email template "' + templateName + '"');
      const built = tpl(data || {});
      subject = built.subject;


      if (!recipient) {
        log(templateName, '', opts.cc, subject, data && data.appId, 'skipped — no address on record');
        return false;
      }
      if (!cfgBool('EMAILS_ENABLED')) {
        log(templateName, recipient, opts.cc, subject, data && data.appId, 'suppressed — EMAILS_ENABLED=false');
        return false;
      }


      const logo = Files.logoBlob();
      const payload = {
        to: recipient,
        subject: subject,
        htmlBody: wrap(subject, built.body, !!logo),
        body: built.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        name: Util.trim(cfg('EMAIL_SENDER_NAME')) || (cfg('COMPANY_NAME') + ' ESOP Team')
      };
      if (logo) payload.inlineImages = { logo: logo };
      if (opts.cc) payload.cc = opts.cc;


      // Recipients see and reply to the ESOP mailbox even while the script
      // still runs under an individual's Google account. Setting the actual
      // `from` needs that address configured as a send-as alias on the
      // sending account; until then EMAIL_FROM should be left blank, and
      // Gmail silently ignores an unverified alias rather than failing.
      const replyTo = Util.trim(cfg('EMAIL_REPLY_TO')) || Util.trim(cfg('SUPPORT_EMAIL'));
      if (replyTo) payload.replyTo = replyTo;
      const from = Util.trim(cfg('EMAIL_FROM'));
      if (from) payload.from = from;


      if (opts.attachFileIds && opts.attachFileIds.length) {
        const blobs = [];
        opts.attachFileIds.forEach(function (id) {
          try { blobs.push(DriveApp.getFileById(id).getBlob()); } catch (e) { /* skip */ }
        });
        if (blobs.length) payload.attachments = blobs;
      }


      MailApp.sendEmail(payload);
      log(templateName, recipient, opts.cc, subject, data && data.appId, 'sent');
      return true;
    } catch (e) {
      console.error('mail ' + templateName + ' -> ' + recipient + ': ' + e);
      log(templateName, recipient, opts.cc, subject, data && data.appId, 'FAILED: ' + e);
      return false;
    }
  }


  /** Send the same template to every admin on the notify list. */
  function sendToAdmins(templateName, data, options) {
    const list = Util.trim(cfg('ADMIN_NOTIFY_EMAILS'))
      .split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (!list.length) return false;
    return send(templateName, list.join(','), data, options);
  }


  function log(template, to, cc, subject, appId, result) {
    try {
      Repo.append(T.EMAIL_LOG, {
        Timestamp: Util.stamp(), Template: template, To: to || '', Cc: cc || '',
        Subject: subject || '', AppID: appId || '', Result: result
      });
    } catch (e) {
      console.error('email log failed: ' + e);
    }
  }


  return { send: send, sendToAdmins: sendToAdmins };
})();


