/**
 * Partners.gs — the fund partners, as data rather than as code.
 *
 * Who the partners are will change: one is dropped, another is added, a
 * contact leaves and the notification address moves. None of that should need
 * a code push, so the list lives on the FundPartners tab and the ESOP team
 * manages it from the portal.
 *
 * Two rules hold this together:
 *
 *   Rows are never deleted, only deactivated. An application records its
 *   partner by NAME, so removing a row would leave last year's applications
 *   pointing at a partner that no longer exists. Deactivating stops new
 *   applications choosing it while every existing one still resolves.
 *
 *   A name is never edited once it has been used. Same reason — the name IS
 *   the foreign key. Renaming would orphan the history and the partner's own
 *   logins. To change a name, deactivate the old row and add a new one.
 *
 * Notification addresses and portal access are separate things:
 *   ContactEmails on the partner row  -> who gets told about a request
 *   a Users row with role FundPartner -> who can sign in and act on it
 * A partner needs at least one login to be selectable at all, because
 * somebody has to be able to enter the demat account and the payment.
 */


const Partners = (function () {


  function rows() {
    return Repo.objects(T.FUND_PARTNERS)
      .filter(r => Util.trim(r.PartnerName))
      .map(function (r) {
        return {
          name: Util.trim(r.PartnerName),
          status: Util.trim(r.Status) || 'Active',
          active: Util.trim(r.Status).toLowerCase() !== 'inactive',
          contactEmails: emailList(r.ContactEmails),
          notes: Util.trim(r.Notes),
          createdAt: Util.trim(r.CreatedAt),
          updatedAt: Util.trim(r.UpdatedAt),
          updatedBy: Util.trim(r.UpdatedBy),
          _row: r._row
        };
      });
  }


  function emailList(v) {
    return Util.trim(v).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }


  /** Every partner, active or not. */
  function all() { return rows(); }


  /** Only those a new application may choose. */
  function active() { return rows().filter(p => p.active); }


  function names() { return rows().map(p => p.name); }
  function activeNames() { return active().map(p => p.name); }


  function find(name) {
    const key = Util.trim(name).toLowerCase();
    return rows().filter(p => p.name.toLowerCase() === key)[0] || null;
  }


  /**
   * Resolve a name a participant is trying to choose.
   * Rejects both the unknown and the retired, with different wording — the
   * difference matters to whoever reads the message.
   */
  function requireSelectable(name) {
    const p = find(name);
    if (!p) throw new Error('"' + Util.trim(name) + '" is not one of our fund partners.');
    if (!p.active) {
      throw new Error(p.name + ' is no longer available as a fund partner. ' +
        'Choose another, or pay the tax yourself.');
    }
    return p;
  }


  /** The active portal logins for a partner — who can actually act on a request. */
  function logins(name) {
    const key = Util.trim(name);
    return Repo.filter(T.USERS, u =>
      Util.trim(u.Role) === ROLE.PARTNER &&
      Util.trim(u.FundPartnerName) === key &&
      Util.trim(u.Status).toLowerCase() === 'active');
  }


  /**
   * Everyone to notify about a request: the contact addresses on the partner
   * record plus the addresses of their logins, de-duplicated.
   *
   * Both, because the two serve different people — a relationship manager who
   * never signs in still needs to know a request has arrived, and an
   * operations login that was created without a contact address still needs
   * the mail.
   */
  function notifyEmails(name) {
    const p = find(name);
    const out = [];
    const seen = {};
    const add = function (e) {
      const v = Util.trim(e);
      if (!v) return;
      const k = v.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(v);
    };
    if (p) p.contactEmails.forEach(add);
    logins(name).forEach(u => add(u.LoginEmail));
    return out;
  }


  /** Can a participant actually route a request to this partner today? */
  function readiness(name) {
    const p = find(name);
    const ls = logins(name);
    return {
      name: p ? p.name : Util.trim(name),
      exists: !!p,
      active: !!(p && p.active),
      logins: ls.length,
      contactEmails: p ? p.contactEmails : [],
      // A login is what makes a partner usable: without one nobody can enter
      // the demat account or feed the payment.
      selectable: !!(p && p.active && ls.length > 0)
    };
  }


  /**
   * Add a partner, or update the contact details of one that exists.
   *
   * The name is the key, so an existing row is matched on it and never
   * rewritten. Renaming is deliberately not offered.
   */
  function save(spec, actorId) {
    const name = Util.trim(spec.name);
    if (!name) throw new Error('Enter the fund partner\'s name.');
    if (name.length < 3) throw new Error('That name is too short to be recognisable.');


    const emails = emailList(spec.contactEmails);
    emails.forEach(function (e) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
        throw new Error('"' + e + '" does not look like an email address.');
      }
    });


    const stamp = Util.stamp();
    const existing = find(name);
    if (existing) {
      Repo.update(T.FUND_PARTNERS, existing._row, {
        ContactEmails: emails.join(', '),
        Notes: Util.trim(spec.notes),
        UpdatedAt: stamp,
        UpdatedBy: actorId || 'system'
      });
      audit(actorId, ROLE.ADMIN, 'PARTNER_UPDATED', '', name + ' — ' + (emails.join(', ') || 'no contacts'));
      return { ok: true, created: false, name: existing.name };
    }


    Repo.append(T.FUND_PARTNERS, {
      PartnerName: name,
      Status: 'Active',
      ContactEmails: emails.join(', '),
      Notes: Util.trim(spec.notes),
      CreatedAt: stamp,
      CreatedBy: actorId || 'system',
      UpdatedAt: stamp,
      UpdatedBy: actorId || 'system'
    });
    audit(actorId, ROLE.ADMIN, 'PARTNER_ADDED', '', name + ' — ' + (emails.join(', ') || 'no contacts'));
    return { ok: true, created: true, name: name };
  }


  /**
   * Retire or reinstate a partner.
   *
   * Retiring is refused while requests are still open with them: those
   * participants are waiting on that partner to act, and quietly removing
   * the partner would strand them with no route to a paid tax bill.
   */
  function setStatus(name, status, actorId) {
    const p = find(name);
    if (!p) throw new Error('No fund partner called "' + Util.trim(name) + '".');
    const want = Util.trim(status);
    if (['Active', 'Inactive'].indexOf(want) < 0) throw new Error('Status must be Active or Inactive.');


    if (want === 'Inactive') {
      const open = Repo.filter(T.PARTNER_REQUESTS, r =>
        Util.trim(r.FundPartnerName) === p.name &&
        [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK, PARTNER_STATUS.PAID]
          .indexOf(Util.trim(r.Status)) >= 0);
      if (open.length) {
        throw new Error(p.name + ' still has ' + open.length + ' request' +
          (open.length === 1 ? '' : 's') + ' in progress (' +
          open.map(r => Util.trim(r.AppID)).join(', ') +
          '). Settle or reassign those before retiring them, or the participants ' +
          'are left with nobody able to pay their tax.');
      }
    }


    Repo.update(T.FUND_PARTNERS, p._row, {
      Status: want,
      UpdatedAt: Util.stamp(),
      UpdatedBy: actorId || 'system'
    });
    audit(actorId, ROLE.ADMIN, 'PARTNER_STATUS', '', p.name + ' -> ' + want);
    return { ok: true, name: p.name, status: want };
  }


  /**
   * Write the seed names in if the tab is empty.
   * Called by createWorkbook, so a fresh install still has the three we
   * started with and nothing has to be typed twice.
   */
  function seedIfEmpty(actorId) {
    if (rows().length) return 0;
    const stamp = Util.stamp();
    Repo.appendAll(T.FUND_PARTNERS, DEFAULT_FUND_PARTNERS.map(function (n) {
      return {
        PartnerName: n,
        Status: 'Active',
        ContactEmails: '',
        Notes: 'Seeded at setup',
        CreatedAt: stamp,
        CreatedBy: actorId || 'setup',
        UpdatedAt: stamp,
        UpdatedBy: actorId || 'setup'
      };
    }));
    return DEFAULT_FUND_PARTNERS.length;
  }


  return {
    all: all,
    active: active,
    names: names,
    activeNames: activeNames,
    find: find,
    requireSelectable: requireSelectable,
    logins: logins,
    notifyEmails: notifyEmails,
    readiness: readiness,
    save: save,
    setStatus: setStatus,
    seedIfEmpty: seedIfEmpty
  };
})();


