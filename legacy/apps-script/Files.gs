/**
 * Files.gs — one Drive folder per employee, one subfolder per application.
 *
 *   <root>/
 *     PW-4471 — Ganesh Jadhav/
 *       2026-09 — APP-202609-PW4471/
 *         CML — 2026-09-08.pdf
 *         PAN — 2026-09-08.jpg
 *         Exercise payment proof — 2026-09-08.pdf
 *         Tax payment proof — 2026-09-22.pdf
 *         Exercise Notice — APP-202609-PW4471.pdf
 *
 * Uploads arrive base64-encoded through google.script.run, are size- and
 * type-checked here, and are never made public — the admin screen streams them
 * back through the portal, so nothing is exposed by link.
 */


const Files = (function () {


  function rootFolder() {
    const id = Util.trim(cfg('DRIVE_ROOT_FOLDER_ID'));
    if (id) {
      try {
        return DriveApp.getFolderById(id);
      } catch (e) {
        throw new Error('DRIVE_ROOT_FOLDER_ID in the Config tab is not a folder this account can open.');
      }
    }
    // Create a root next to the spreadsheet on first use and remember it.
    const name = APP.NAME + ' — Documents';
    const it = DriveApp.getFoldersByName(name);
    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
    setConfigValue('DRIVE_ROOT_FOLDER_ID', folder.getId());
    return folder;
  }


  function childFolder(parent, name) {
    const it = parent.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return parent.createFolder(name);
  }


  /** The employee's single permanent folder, recorded on their row. */
  function employeeFolder(employeeRow) {
    const existingId = Util.trim(employeeRow.DriveFolderId);
    if (existingId) {
      try {
        return DriveApp.getFolderById(existingId);
      } catch (e) { /* fall through and recreate */ }
    }
    const label = Util.trim(employeeRow.EmployeeID) +
      (Util.trim(employeeRow.Name) ? ' — ' + Util.trim(employeeRow.Name) : '');
    const folder = childFolder(rootFolder(), label);
    Repo.update(T.EMPLOYEES, employeeRow._row, { DriveFolderId: folder.getId(), UpdatedAt: Util.stamp() });
    return folder;
  }


  /** The per-application subfolder, recorded on the application row. */
  function applicationFolder(app, employeeRow) {
    const existingId = Util.trim(app.FolderId);
    if (existingId) {
      try {
        return DriveApp.getFolderById(existingId);
      } catch (e) { /* fall through */ }
    }
    const label = Util.windowKey(app.WindowID) + ' — ' + Util.trim(app.AppID);
    const folder = childFolder(employeeFolder(employeeRow), label);
    Repo.update(T.APPLICATIONS, app._row, { FolderId: folder.getId(), UpdatedAt: Util.stamp() });
    return folder;
  }


  /**
   * Store one uploaded file.
   * upload = { name, mimeType, dataBase64 }
   * Any previous file for the same `label` in that folder is trashed, so a
   * re-upload replaces rather than accumulates.
   */
  function save(folder, label, upload) {
    if (!upload || !upload.dataBase64) throw new Error('No file was received. Please choose the file again.');


    const mime = Util.trim(upload.mimeType);
    if (APP.ALLOWED_UPLOAD_TYPES.indexOf(mime) < 0) {
      throw new Error('Upload a PDF, JPG or PNG file. That file is "' + (mime || 'of an unknown type') + '".');
    }


    let bytes;
    try {
      bytes = Utilities.base64Decode(upload.dataBase64);
    } catch (e) {
      throw new Error('That file could not be read. Please try uploading it again.');
    }
    const mb = bytes.length / (1024 * 1024);
    if (mb > APP.MAX_UPLOAD_MB) {
      throw new Error('That file is ' + mb.toFixed(1) + ' MB. The limit is ' + APP.MAX_UPLOAD_MB +
        ' MB — please compress it or upload a clearer, smaller scan.');
    }


    const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/png' ? 'png' : 'jpg');
    const filename = label + ' — ' + Util.dateKey(new Date()) + '.' + ext;


    // Replace an earlier version of the same document.
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getName().indexOf(label + ' — ') === 0) f.setTrashed(true);
    }


    const blob = Utilities.newBlob(bytes, mime, filename);
    const file = folder.createFile(blob);
    file.setDescription(label + ' uploaded via ' + APP.NAME + ' on ' + Util.stamp());
    return {
      fileId: file.getId(),
      name: file.getName(),
      mimeType: mime,
      sizeKb: Math.round(bytes.length / 1024)
    };
  }


  /** Metadata for the admin screen; returns null for a missing/trashed file. */
  function meta(fileId) {
    const id = Util.trim(fileId);
    if (!id) return null;
    try {
      const f = DriveApp.getFileById(id);
      if (f.isTrashed()) return null;
      return {
        fileId: id,
        name: f.getName(),
        mimeType: f.getMimeType(),
        sizeKb: Math.round(f.getSize() / 1024),
        updatedAt: Util.stamp(f.getLastUpdated())
      };
    } catch (e) {
      return null;
    }
  }


  /**
   * Stream a stored file back to an authorised viewer as a data URI. Used by
   * the admin review screen so documents display inline without ever being
   * shared out of Drive.
   */
  /**
   * The company logo, as a data URI the portal and the notice can embed.
   *
   * Read from Drive once and cached, because it is wanted on every page load
   * and the file never changes. Converted to PNG: the supplied file is WebP,
   * which browsers render but Google's HTML-to-PDF conversion does not
   * reliably, and the exercise notice becomes a PDF.
   *
   * Returns '' when no logo is configured or it cannot be read — the pages
   * then simply show the wordmark, which is why none of them check.
   */
  function logoDataUri() {
    const id = Util.trim(cfg('LOGO_FILE_ID'));
    if (!id) return '';


    const cache = CacheService.getScriptCache();
    const key = 'logo:' + id;
    try {
      const hit = cache.get(key);
      if (hit) return hit;
    } catch (e) { /* cache is a convenience, never a dependency */ }


    try {
      const blob = DriveApp.getFileById(id).getBlob();
      let png = blob;
      if (blob.getContentType() !== 'image/png') {
        try {
          png = blob.getAs('image/png');
        } catch (e) {
          png = blob;              // fall back to whatever it already is
        }
      }
      const uri = 'data:' + png.getContentType() + ';base64,' +
        Utilities.base64Encode(png.getBytes());
      // CacheService caps a value at 100KB; skip caching anything larger
      // rather than throwing on every request.
      if (uri.length < 95000) {
        try { cache.put(key, uri, 21600); } catch (e) { /* ignore */ }
      }
      return uri;
    } catch (e) {
      console.warn('logo ' + id + ' could not be read: ' + e.message);
      return '';
    }
  }


  /**
   * The logo as a blob, for embedding in email rather than as a data URI.
   *
   * Every email calls this, and it used to fetch the file from Drive and
   * convert it to PNG each time — a Drive read plus an image conversion on
   * the critical path of every save that notifies somebody. The bytes are
   * cached instead, so only the first email of the session pays for it.
   */
  function logoBlob() {
    const id = Util.trim(cfg('LOGO_FILE_ID'));
    if (!id) return null;


    const cache = CacheService.getScriptCache();
    const key = 'logopng:' + id;
    try {
      const hit = cache.get(key);
      if (hit) {
        return Utilities.newBlob(Utilities.base64Decode(hit), 'image/png', 'logo.png');
      }
    } catch (e) { /* the cache is a convenience, never a dependency */ }


    try {
      const blob = DriveApp.getFileById(id).getBlob();
      const png = blob.getContentType() === 'image/png' ? blob : blob.getAs('image/png');
      const bytes = png.getBytes();
      // CacheService caps one value at 100KB.
      if (bytes.length < 70000) {
        try { cache.put(key, Utilities.base64Encode(bytes), 21600); } catch (e) { /* ignore */ }
      }
      return png.setName('logo.png');
    } catch (e) {
      return null;
    }
  }


  function inline(fileId) {
    const f = DriveApp.getFileById(Util.trim(fileId));
    const size = f.getSize();
    const out = {
      name: f.getName(),
      sizeBytes: size,
      // Always returned, so a reviewer has a way through even when the
      // browser will not render the file itself.
      driveUrl: f.getUrl(),
      previewUrl: 'https://drive.google.com/file/d/' + Util.trim(fileId) + '/preview'
    };
    if (size > 12 * 1024 * 1024) {
      out.tooLarge = true;
      out.mimeType = '';
      out.base64 = '';
      return out;
    }
    const blob = f.getBlob();
    out.mimeType = blob.getContentType();
    // Sent as bare base64, not a data: URI. Chrome blocks navigating a frame
    // to a data: URL, which is why PDFs previewed as a blank pane while
    // images were fine — the client turns this into a blob: URL instead.
    out.base64 = Utilities.base64Encode(blob.getBytes());
    return out;
  }


  /** Write a Config value and drop the cache. */
  function setConfigValue(key, value) {
    const existing = Repo.find(T.CONFIG, r => Util.trim(r.Key) === key);
    if (existing) Repo.update(T.CONFIG, existing._row, { Value: value });
    else Repo.append(T.CONFIG, { Key: key, Value: value, Notes: 'set automatically' });
    clearConfigCache();
  }


  return {
    rootFolder: rootFolder,
    logoDataUri: logoDataUri,
    logoBlob: logoBlob,
    employeeFolder: employeeFolder,
    applicationFolder: applicationFolder,
    save: save,
    meta: meta,
    inline: inline,
    setConfigValue: setConfigValue
  };
})();


