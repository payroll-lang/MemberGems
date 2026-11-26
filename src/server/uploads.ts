import 'server-only';
import type { UserDoc } from '@/lib/schema';
import { todayIst } from '@/lib/time';
import { UserError } from './core/errors';
import { createUpload, EMPLOYEE_UPLOAD_PURPOSES, isFilePurpose, PARTNER_UPLOAD_PURPOSES, type UploadTicket } from './files';
import { getPartnerRequest } from './partnerRequests';
import { assertEditable, assertMayAct, liveApp, loadState } from './participant/state';
import { loadSettings } from './settings';

export interface UploadRequest {
  purpose: unknown;
  appId: unknown;
  requestId?: unknown;
  contentType: unknown;
  size: unknown;
  name: unknown;
}

/**
 * Who may upload what, checked before a signed URL is issued:
 *   a participant — their own application in play, while they may still edit it;
 *   a fund partner — a request assigned to their firm.
 * The mutation that attaches the file checks again.
 */
export async function authoriseUpload(user: UserDoc, req: UploadRequest): Promise<UploadTicket> {
  const purpose = req.purpose;
  if (!isFilePurpose(purpose)) throw new UserError('Unknown document type.');
  const appId = String(req.appId ?? '').trim();

  if (user.role === 'Employee') {
    if (!EMPLOYEE_UPLOAD_PURPOSES.includes(purpose)) throw new UserError('That document cannot be uploaded here.');
    const st = await loadState(user.userId, await loadSettings(), todayIst());
    assertMayAct(st);
    const app = liveApp(st);
    if (!app || app.appId !== appId) throw new UserError('Start by recording the options you wish to exercise in step 1.');
    assertEditable(app);
    return createUpload({ ownerEmployeeId: user.userId, appId, purpose, contentType: req.contentType, size: req.size, name: req.name, uploadedBy: user.userId });
  }

  if (user.role === 'FundPartner') {
    if (!PARTNER_UPLOAD_PURPOSES.includes(purpose)) throw new UserError('That document cannot be uploaded here.');
    const pr = await getPartnerRequest(String(req.requestId ?? '').trim());
    if (!pr || !user.fundPartnerId || pr.fundPartnerId !== user.fundPartnerId || pr.appId !== appId) {
      throw new UserError('That request is not assigned to you.');
    }
    return createUpload({
      ownerEmployeeId: pr.employeeId, appId, purpose, contentType: req.contentType, size: req.size, name: req.name,
      uploadedBy: user.userId, requestId: pr.requestId,
    });
  }

  throw new UserError('Uploads are not available for this account.');
}
