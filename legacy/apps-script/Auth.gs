/**
 * Auth.gs — user-ID + password login for employees, admins and fund partners.
 *
 * Deliberately not Google sign-in: exited employees no longer have a domain
 * account, and the brief requires them to be able to participate.
 *
 * Password storage: per-user random salt + a server-side pepper held in Script
 * Properties (never in the Sheet), run through iterated HMAC-SHA256. If the
 * spreadsheet ever leaks, the hashes are not crackable without the pepper.
 *
 * Sessions: stateless signed tokens. Payload carries the user ID, role, token
 * version and expiry; the signature is HMAC-SHA256 under the same pepper.
 * Bumping a user's TokenVersion invalidates every token they hold.
 */


const Auth = (function () {


  const PEPPER_KEY = 'ESOP_PEPPER';


  function pepper() {
    const props = PropertiesService.getScriptProperties();
    let p = props.getProperty(PEPPER_KEY);
    if (!p) {
      p = Utilities.base64EncodeWebSafe(
        Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
          Utilities.getUuid() + Utilities.getUuid() + new Date().getTime())
      );
      props.setProperty(PEPPER_KEY, p);
    }
    return p;
  }


  function hmac(message, key) {
    return Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(message, key)
    );
  }


  function newSalt() {
    return Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid())
    ).slice(0, 32);
  }


  /**
   * Iterated HMAC.
   *
   * The round count matters far less here than it would elsewhere, because
   * every hash is also keyed by a 256-bit pepper that lives in Script
   * Properties and never appears in the workbook. Someone who obtains the
   * Sheet has salted hashes and no key, so no number of rounds is what stops
   * them; someone who has the pepper has the whole project anyway.
   *
   * That matters because each round is a separate service call out of V8 at
   * roughly 1-3 ms. The original 5,000 rounds cost five to fifteen seconds on
   * every login — by far the largest single delay in the portal.
   *
   * Stored hashes therefore carry their own round count, `r200$…`, so the
   * number can change again without invalidating anyone's password. A stored
   * value with no prefix predates this and is verified at the old 5,000.
   */
  function hashRaw(password, salt, rounds) {
    const key = pepper() + '|' + salt;
    let h = String(password);
    for (let i = 0; i < rounds; i++) {
      h = hmac(h, key);
    }
    return h;
  }


  /** Hash for storage, tagged with the round count used. */
  function hashPassword(password, salt) {
    return 'r' + APP.PASSWORD_ITERATIONS + '$' +
      hashRaw(password, salt, APP.PASSWORD_ITERATIONS);
  }


  /**
   * Check a candidate against a stored hash of either format.
   * `stale` is true when the stored value should be rewritten at the current
   * round count — done on the next successful login, transparently.
   */
  function verifyPassword(password, salt, stored) {
    const s = Util.trim(stored);
    if (!s) return { ok: false, stale: false };
    const m = s.match(/^r(\d+)\$(.*)$/);
    const rounds = m ? Number(m[1]) : APP.LEGACY_PASSWORD_ITERATIONS;
    const digest = m ? m[2] : s;
    return {
      ok: constantTimeEquals(hashRaw(password, salt, rounds), digest),
      stale: rounds !== APP.PASSWORD_ITERATIONS
    };
  }


  function constantTimeEquals(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  }


  /* ---------------- tokens ---------------- */


  function issueToken(user) {
    const payload = {
      u: Util.trim(user.UserID),
      r: Util.trim(user.Role),
      v: Util.num(user.TokenVersion, 1),
      e: new Date().getTime() + APP.SESSION_HOURS * 3600 * 1000
    };
    const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
    return body + '.' + hmac(body, pepper());
  }


  /** Returns the session object, or throws an Error the client turns into a re-login. */
  function verifyToken(token) {
    const t = Util.trim(token);
    const dot = t.lastIndexOf('.');
    if (dot < 1) throw authError('Your session has ended. Please sign in again.');
    const body = t.slice(0, dot);
    const sig = t.slice(dot + 1);
    if (!constantTimeEquals(sig, hmac(body, pepper()))) {
      throw authError('Your session has ended. Please sign in again.');
    }
    let payload;
    try {
      payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
    } catch (e) {
      throw authError('Your session has ended. Please sign in again.');
    }
    if (!payload || payload.e < new Date().getTime()) {
      throw authError('Your session has expired. Please sign in again.');
    }
    const user = findUser(payload.u);
    if (!user) throw authError('This account is no longer active.');
    if (Util.trim(user.Status).toLowerCase() !== 'active') {
      throw authError('This account is not active. Please contact the ESOP team.');
    }
    if (Util.num(user.TokenVersion, 1) !== Util.num(payload.v, 1)) {
      throw authError('Your session has ended because your password changed. Please sign in again.');
    }
    return {
      userId: Util.trim(user.UserID),
      role: Util.trim(user.Role),
      name: Util.trim(user.Name),
      email: Util.trim(user.LoginEmail),
      fundPartnerName: Util.trim(user.FundPartnerName),
      _user: user
    };
  }


  function authError(msg) {
    const e = new Error(msg);
    e.authFailure = true;
    return e;
  }


  /* ---------------- lookup ---------------- */


  function findUser(userId) {
    const key = Util.trim(userId).toUpperCase();
    if (!key) return null;
    return Repo.findOne(T.USERS, 'UserID', key);
  }


  /**
   * Resolve whatever the person typed into a Users row.
   *
   * Accepts either the employee code (PW1130) or any email address on
   * record for them - the report's Access Email ID, the secondary address,
   * an override the ESOP team set, or the login email for an admin or fund
   * partner. People remember their email far better than their employee
   * code, and both resolve to exactly one account.
   *
   * Matching an email does NOT grant anything on its own: the password, or
   * a one-time code sent to that same address, is still what proves it is
   * them.
   */
  function resolveUser(identifier) {
    const raw = Util.trim(identifier);
    if (!raw) return null;


    const direct = findUser(raw);
    if (direct) return direct;
    if (raw.indexOf('@') < 0) return null;


    const email = raw.toLowerCase();


    // Admins and fund partners are identified by their login email.
    const byLogin = Repo.find(T.USERS, u => Util.trim(u.LoginEmail).toLowerCase() === email);
    if (byLogin) return byLogin;


    // Participants are identified by any address on their employee record.
    const emp = Repo.find(T.EMPLOYEES, function (e) {
      return [e.EmailOverride, e.AccessEmail, e.SecondaryEmail]
        .some(v => Util.trim(v).toLowerCase() === email);
    });
    return emp ? findUser(Util.trim(emp.EmployeeID)) : null;
  }


  /* ---------------- login ---------------- */


  function login(userId, password) {
    const id = Util.trim(userId);
    if (!id || !Util.trim(password)) {
      throw new Error('Enter both your user ID and password.');
    }
    const user = resolveUser(id);
    // Same message whether the identifier or the password is wrong.
    const BAD = 'Incorrect user ID or password.';
    if (!user) throw new Error(BAD);


    if (Util.trim(user.Status).toLowerCase() !== 'active') {
      throw new Error('This account is not active. Please contact the ESOP team.');
    }


    const lockedUntil = Util.toDate(user.LockedUntil);
    if (lockedUntil && lockedUntil.getTime() > new Date().getTime()) {
      const mins = Math.ceil((lockedUntil.getTime() - new Date().getTime()) / 60000);
      throw new Error('Too many failed attempts. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + ', or use "Forgot password".');
    }


    const salt = Util.trim(user.PasswordSalt);
    const stored = Util.trim(user.PasswordHash);
    if (!salt || !stored) {
      throw new Error('No password is set on this account yet. Use "Forgot password" to receive a one-time code.');
    }


    const check = verifyPassword(password, salt, stored);
    if (!check.ok) {
      const attempts = Util.num(user.FailedAttempts, 0) + 1;
      const patch = { FailedAttempts: attempts };
      if (attempts >= APP.MAX_LOGIN_ATTEMPTS) {
        patch.LockedUntil = Util.stamp(new Date(new Date().getTime() + APP.LOCKOUT_MINUTES * 60000));
        patch.FailedAttempts = 0;
      }
      Repo.update(T.USERS, user._row, patch);
      audit(Util.trim(user.UserID), Util.trim(user.Role), 'LOGIN_FAILED', '', 'attempt ' + attempts);
      throw new Error(BAD);
    }


    const patch = {
      FailedAttempts: 0,
      LockedUntil: '',
      LastLoginAt: Util.stamp()
    };
    // Silently re-hash anyone still stored at the old round count, so the
    // change costs them one slow login and no reset.
    if (check.stale) patch.PasswordHash = hashPassword(password, salt);
    Repo.update(T.USERS, user._row, patch);
    audit(Util.trim(user.UserID), Util.trim(user.Role), 'LOGIN', '', check.stale ? 'hash upgraded' : '');


    // By the account's own ID, never by what was typed: signing in with an
    // email address resolved fine, then this looked that address up in the
    // UserID column, found nothing, and the whole login died on a null —
    // reported as "Cannot read properties of null" after a correct password.
    const fresh = findUser(Util.trim(user.UserID)) || user;
    return {
      token: issueToken(fresh),
      user: {
        userId: Util.trim(fresh.UserID),
        role: Util.trim(fresh.Role),
        name: Util.trim(fresh.Name),
        email: Util.trim(fresh.LoginEmail),
        fundPartnerName: Util.trim(fresh.FundPartnerName),
        mustResetPassword: String(fresh.MustResetPassword).toLowerCase() === 'true'
      }
    };
  }


  /* ---------------- password reset by one-time code ---------------- */


  /**
   * Sends a one-time code to the address of record. Always reports success so
   * the form cannot be used to discover which user IDs exist.
   */
  function requestResetCode(userId) {
    const user = resolveUser(userId);
    const generic = { ok: true, message: 'If that user ID exists, a one-time code has been emailed to the address on record. It is valid for ' + APP.RESET_CODE_MINUTES + ' minutes.' };
    if (!user) return generic;
    if (Util.trim(user.Status).toLowerCase() !== 'active') return generic;


    const to = notificationEmailFor(user);
    if (!to) return generic;


    const code = Util.randomCode(6);


    // The code gets its own salt, and the password's salt is left alone.
    //
    // This used to overwrite PasswordSalt. The stored PasswordHash had been
    // computed under the OLD salt, so after a reset request it could never
    // match again — meaning anyone who knew an employee code could destroy
    // that person's password without authenticating, and could do it to every
    // participant in a loop. The password now survives an unused code.
    //
    // The ResetCodeSalt column arrived with that fix. Repo.update silently
    // ignores a column the tab does not have, so on a workbook that has not
    // been migrated yet the salt would vanish and every code would fail to
    // verify — a broken sign-in for everyone. Detect that and keep the old
    // behaviour instead, so the worst case is the previous flaw rather than
    // no way in at all.
    const hasCodeSalt = Repo.headers(T.USERS).indexOf('ResetCodeSalt') >= 0;
    const patch = {
      ResetCodeExpiresAt: Util.stamp(new Date(new Date().getTime() + APP.RESET_CODE_MINUTES * 60000)),
      FailedAttempts: 0,
      LockedUntil: ''
    };
    if (hasCodeSalt) {
      const codeSalt = newSalt();
      patch.ResetCodeSalt = codeSalt;
      patch.ResetCodeHash = hashPassword(code, codeSalt);
    } else {
      console.warn('Users tab has no ResetCodeSalt column — run createWorkbook(). ' +
        'Falling back to the shared salt, which invalidates the existing password.');
      const shared = newSalt();
      patch.PasswordSalt = shared;
      patch.ResetCodeHash = hashPassword(code, shared);
    }
    Repo.update(T.USERS, user._row, patch);


    Mailer.send('reset_code', to, {
      name: Util.trim(user.Name) || Util.trim(user.UserID),
      userId: Util.trim(user.UserID),
      code: code,
      minutes: APP.RESET_CODE_MINUTES
    });
    audit(Util.trim(user.UserID), Util.trim(user.Role), 'RESET_CODE_SENT', '', to);
    return generic;
  }


  /** Consumes the code and sets the new password. Returns a fresh session. */
  function setPasswordWithCode(userId, code, newPassword) {
    const user = resolveUser(userId);
    const BAD = 'That code is not valid or has expired. Please request a new one.';
    if (!user) throw new Error(BAD);


    const expires = Util.toDate(user.ResetCodeExpiresAt);
    if (!Util.trim(user.ResetCodeHash) || !expires || expires.getTime() < new Date().getTime()) {
      throw new Error(BAD);
    }
    // Codes issued before ResetCodeSalt existed were hashed under the
    // password salt, so fall back to it — otherwise every code already in
    // someone's inbox would stop working the moment this ships.
    const codeSalt = Util.trim(user.ResetCodeSalt) || Util.trim(user.PasswordSalt);
    if (!verifyPassword(Util.trim(code), codeSalt, Util.trim(user.ResetCodeHash)).ok) {
      throw new Error(BAD);
    }
    validatePasswordStrength(newPassword);


    const newSaltVal = newSalt();
    Repo.update(T.USERS, user._row, {
      PasswordSalt: newSaltVal,
      PasswordHash: hashPassword(newPassword, newSaltVal),
      ResetCodeSalt: '',
      ResetCodeHash: '',
      ResetCodeExpiresAt: '',
      MustResetPassword: false,
      TokenVersion: Util.num(user.TokenVersion, 1) + 1,
      FailedAttempts: 0,
      LockedUntil: '',
      LastLoginAt: Util.stamp()
    });
    audit(Util.trim(user.UserID), Util.trim(user.Role), 'PASSWORD_SET', '', 'via one-time code');


    const fresh = findUser(Util.trim(user.UserID));
    const to = notificationEmailFor(fresh);
    if (to) Mailer.send('password_changed', to, { name: Util.trim(fresh.Name), userId: Util.trim(fresh.UserID) });


    return {
      token: issueToken(fresh),
      user: {
        userId: Util.trim(fresh.UserID),
        role: Util.trim(fresh.Role),
        name: Util.trim(fresh.Name),
        email: Util.trim(fresh.LoginEmail),
        fundPartnerName: Util.trim(fresh.FundPartnerName),
        mustResetPassword: false
      }
    };
  }


  /** Change password while signed in. */
  function changePassword(session, currentPassword, newPassword) {
    const user = findUser(session.userId);
    if (!user) throw new Error('Account not found.');
    if (!verifyPassword(currentPassword, Util.trim(user.PasswordSalt), Util.trim(user.PasswordHash)).ok) {
      throw new Error('Your current password is incorrect.');
    }
    validatePasswordStrength(newPassword);
    const salt = newSalt();
    Repo.update(T.USERS, user._row, {
      PasswordSalt: salt,
      PasswordHash: hashPassword(newPassword, salt),
      MustResetPassword: false,
      TokenVersion: Util.num(user.TokenVersion, 1) + 1
    });
    audit(session.userId, session.role, 'PASSWORD_CHANGED', '', '');
    const fresh = findUser(session.userId);
    const to = notificationEmailFor(fresh);
    if (to) Mailer.send('password_changed', to, { name: Util.trim(fresh.Name), userId: Util.trim(fresh.UserID) });
    return { ok: true, token: issueToken(fresh), message: 'Password changed.' };
  }


  function validatePasswordStrength(pw) {
    const p = String(pw || '');
    if (p.length < 8) throw new Error('Choose a password of at least 8 characters.');
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
      throw new Error('Your password must contain at least one letter and one number.');
    }
  }


  /**
   * Where to email a user.
   *
   * For participants the address of record is the report's own `Access Email
   * ID` (or an explicit override), which already carries a personal address
   * for anyone who has separated — so an ex-employee is reachable without any
   * extra bookkeeping.
   */
  function notificationEmailFor(user) {
    if (Util.trim(user.Role) === ROLE.EMPLOYEE) {
      const emp = Repo.findOne(T.EMPLOYEES, 'EmployeeID', Util.trim(user.UserID));
      if (emp) {
        const ofRecord = Domain.emailFor(emp);
        if (ofRecord) return ofRecord;
      }
    }
    return Util.trim(user.LoginEmail);
  }


  /* ---------------- provisioning (called by Admin) ---------------- */


  /**
   * Creates or refreshes a login. Emails a one-time code rather than a
   * password, so no plaintext password is ever transmitted or stored.
   */
  function provisionUser(spec, actorId, options) {
    const opts = options || {};
    const id = Util.trim(spec.userId).toUpperCase();
    if (!id) throw new Error('A user ID is required.');
    const role = Util.trim(spec.role);
    if ([ROLE.EMPLOYEE, ROLE.ADMIN, ROLE.PARTNER].indexOf(role) < 0) {
      throw new Error('Unknown role "' + role + '".');
    }
    if (role === ROLE.PARTNER) {
      // Matched against the live list, not a compiled-in one, and against
      // every partner rather than only the active ones: a login may need
      // creating or resetting for a partner mid-retirement so they can
      // finish the requests still open with them.
      if (!Partners.find(Util.trim(spec.fundPartnerName))) {
        throw new Error('Choose one of the fund partners on record for a fund partner login. ' +
          'Add the partner under Logins first if they are new.');
      }
    }


    const existing = findUser(id);
    const code = Util.randomCode(6);
    const codeSalt = newSalt();
    const row = {
      UserID: id,
      Role: role,
      Name: Util.trim(spec.name),
      LoginEmail: Util.trim(spec.email),
      FundPartnerName: role === ROLE.PARTNER ? Util.trim(spec.fundPartnerName) : '',
      // Provisioning DOES clear the password — that is its purpose, and it is
      // an authenticated admin action, unlike a reset-code request.
      PasswordSalt: newSalt(),
      ResetCodeSalt: codeSalt,
      ResetCodeHash: hashPassword(code, codeSalt),
      ResetCodeExpiresAt: Util.stamp(new Date(new Date().getTime() + APP.RESET_CODE_MINUTES * 60000)),
      MustResetPassword: true,
      Status: 'Active',
      FailedAttempts: 0,
      LockedUntil: ''
    };


    if (existing) {
      row.TokenVersion = Util.num(existing.TokenVersion, 1) + 1;
      row.PasswordHash = '';
      Repo.update(T.USERS, existing._row, row);
    } else {
      row.TokenVersion = 1;
      row.PasswordHash = '';
      row.CreatedAt = Util.stamp();
      row.CreatedBy = actorId || 'system';
      Repo.append(T.USERS, row);
    }


    const fresh = findUser(id);
    const to = notificationEmailFor(fresh);


    // Whether to email the code is a decision for the caller and for Config.
    // Default is NOT to: inviting participants is a manual activity, and a
    // bulk send cannot be taken back.
    const shouldEmail = opts.sendEmail === undefined ? inviteEmailsAuto() : !!opts.sendEmail;
    let emailed = false;
    if (shouldEmail && to) {
      emailed = Mailer.send('account_ready', to, {
        name: Util.trim(fresh.Name) || id,
        userId: id,
        code: code,
        minutes: APP.RESET_CODE_MINUTES,
        role: role
      });
    }
    audit(actorId || 'system', ROLE.ADMIN, existing ? 'USER_RESET' : 'USER_CREATED', '',
      id + ' (' + role + ')' + (emailed ? ' — code emailed' : ' — no email sent'));
    return {
      ok: true, userId: id,
      emailAddress: to || '',
      emailed: emailed,
      // Returned so the ESOP team can pass it on by hand. It is single-use
      // and expires; it is never stored anywhere in readable form.
      oneTimeCode: emailed ? '' : code,
      expiresInMinutes: APP.RESET_CODE_MINUTES
    };
  }


  function setUserStatus(userId, status, actorId) {
    const user = findUser(userId);
    if (!user) throw new Error('User not found.');
    Repo.update(T.USERS, user._row, {
      Status: status,
      TokenVersion: Util.num(user.TokenVersion, 1) + 1
    });
    audit(actorId, ROLE.ADMIN, 'USER_STATUS', '', Util.trim(user.UserID) + ' -> ' + status);
    return { ok: true };
  }


  return {
    login: login,
    resolveUser: resolveUser,
    verifyToken: verifyToken,
    issueToken: issueToken,
    requestResetCode: requestResetCode,
    setPasswordWithCode: setPasswordWithCode,
    changePassword: changePassword,
    provisionUser: provisionUser,
    setUserStatus: setUserStatus,
    findUser: findUser,
    notificationEmailFor: notificationEmailFor
  };
})();


