import 'server-only';
import ExcelJS from 'exceljs';
import { windowKey } from '@/domain';
import { audit } from '@/lib/audit';
import { env } from '@/lib/env';
import type { UserDoc } from '@/lib/schema';
import { applicationsInWindow, linesOf, taxPaymentsOf } from '../applications';
import { partnerRequestOf } from '../partnerRequests';
import { EXPORT_COLUMNS, TEXT_COLUMNS, exportRowsFor, type ExportRow } from './core/exportRows';
import { employeesById } from './data';

/**
 * AdminApi.exportWindow, as an .xlsx download (legacy wrote an "Export
 * YYYY-MM" tab). Code-like columns are written as text so leading zeros
 * survive. FolderURL — a Drive folder link on the old portal — is now the
 * application's page on this portal.
 */
export async function exportRows(windowId: string): Promise<ExportRow[]> {
  const win = windowKey(windowId);
  const apps = (await applicationsInWindow(win)).sort((a, b) => a.appId.localeCompare(b.appId));
  const emps = await employeesById(apps.map((a) => a.employeeId));
  const base = env().PORTAL_URL.replace(/\/+$/, '');
  const rows: ExportRow[] = [];
  for (const a of apps) {
    const [lines, payments, pr] = await Promise.all([linesOf(a.appId), taxPaymentsOf(a.appId), partnerRequestOf(a.appId)]);
    rows.push(...exportRowsFor({
      windowId: win, app: a, employee: emps.get(a.employeeId) ?? null, lines, payments, partnerRequest: pr,
      folderUrl: base + '/admin/applications/' + encodeURIComponent(a.appId),
    }));
  }
  return rows;
}

export async function exportWorkbook(user: UserDoc, windowId: string): Promise<{ bytes: Uint8Array; rows: number; name: string }> {
  const win = windowKey(windowId);
  const rows = await exportRows(win);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ESOP Exercise Portal';
  wb.created = new Date();
  const ws = wb.addWorksheet('Export ' + win, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((h) => ({ header: h, key: h, width: Math.max(10, Math.min(36, h.length + 4)) }));
  TEXT_COLUMNS.forEach((h) => { ws.getColumn(h).numFmt = '@'; });
  rows.forEach((r) => ws.addRow(EXPORT_COLUMNS.map((h) => ((TEXT_COLUMNS as readonly string[]).includes(h) ? String(r[h] ?? '') : r[h]))));
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  await audit(user.userId, 'Admin', 'EXPORTED', win + ': ' + rows.length + ' rows');
  return { bytes: new Uint8Array(buf as ArrayBuffer), rows: rows.length, name: 'ESOP export ' + win + '.xlsx' };
}
