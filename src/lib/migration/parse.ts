import ExcelJS from 'exceljs';
import { num } from '@/domain/util';
import type {
  AuditDoc,
  EmployeeDoc,
  FmvDoc,
  FundPartnerDoc,
  GrantDoc,
  TaxPositionDoc,
  Tranche,
  UserDoc,
  UserSecretDoc,
  WindowDoc,
} from '../schema';

/**
 * Turns the legacy "ESOP Exercise Portal — Data" workbook (downloaded as
 * .xlsx) into Firestore documents. Pure: no I/O beyond reading the buffer.
 *
 * What is deliberately NOT imported (agreed with the ESOP team):
 *  - Applications, ApplicationLines, TaxPayments, FundPartnerRequests: all
 *    test data so far.
 *  - Grants of plans outside ALLOWED_PLANS ("Test Plan" is dropped).
 *  - EmailLog, Export tabs, _Scratch.
 */

type Row = Record<string, unknown>;

export interface MigrationPlan {
  config: Record<string, string>;
  taxRules: { slabs: { regime: string; above: number; rate: number }[]; surcharge: { regime: string; above: number; rate: number }[]; rules: { regime: string; rule: string; value: string }[] };
  users: UserDoc[];
  secrets: Record<string, UserSecretDoc>;
  employees: EmployeeDoc[];
  grants: GrantDoc[];
  fmv: FmvDoc[];
  windows: WindowDoc[];
  partners: FundPartnerDoc[];
  taxPositions: TaxPositionDoc[];
  audit: AuditDoc[];
  report: {
    counts: Record<string, number>;
    skipped: Record<string, number>;
    totals: Record<string, number>;
    warnings: string[];
  };
}

const s = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join('').trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return String(o.result).trim();
  }
  return String(v).trim().replace(/^'/, '');
};

/** A calendar date cell → 'yyyy-MM-dd'. Sheets exports dates as UTC midnight of the wall date. */
export function dateKey(v: unknown): string {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const t = s(v);
  if (!t || t === '-') return '';
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(t);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** A wall-clock IST timestamp cell → ISO instant. */
export function istInstant(v: unknown): string {
  let wall = '';
  if (v instanceof Date) wall = isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 19);
  else {
    const t = s(v);
    const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) wall = `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:${m[4] ?? '00'}`;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) wall = `${t}T00:00:00`;
  }
  if (!wall) return '';
  return new Date(`${wall}+05:30`).toISOString();
}

const bool = (v: unknown): boolean => ['true', 'yes', 'y', '1'].includes(s(v).toLowerCase());
const n = (v: unknown): number => num(s(v) === '' ? '' : (v instanceof Date ? '' : (typeof v === 'number' ? v : s(v))));
const nOrNull = (v: unknown): number | null => (s(v) === '' ? null : n(v));
const emails = (v: unknown): string[] =>
  s(v).split(/[\s,;]+/).map((e) => e.toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

function rows(ws: ExcelJS.Worksheet | undefined): Row[] {
  if (!ws) return [];
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => s(h));
  const out: Row[] = [];
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const vals = (r.values as unknown[]).slice(1);
    if (!vals.some((v) => s(v) !== '')) return;
    const o: Row = {};
    header.forEach((h, j) => {
      if (h) o[h] = vals[j] ?? null;
    });
    out.push(o);
  });
  return out;
}

export function partnerIdFor(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export async function parseWorkbook(buffer: ArrayBuffer | Buffer, importedBy: string): Promise<MigrationPlan> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  const tab = (name: string) => rows(wb.getWorksheet(name));
  const warnings: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const now = new Date().toISOString();

  // ---- Config
  const config: Record<string, string> = {};
  for (const r of tab('Config')) {
    const k = s(r.Key);
    if (k) config[k] = s(r.Value);
  }
  if (!Object.keys(config).length) throw new Error('This does not look like the portal workbook: the Config tab is missing or empty.');
  const plans = (config.ALLOWED_PLANS ?? '').split(',').map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== 'test plan');
  config.ALLOWED_PLANS = plans.join(', ');
  config.FLAT_TAX_ROUNDING = 'rupee';
  // Never email real people from an imported copy: the ESOP team switches
  // these on in Settings at go-live.
  config.EMAILS_ENABLED = 'false';
  config.BULK_EMAILS_ENABLED = 'false';
  delete config.PORTAL_URL; // the Apps Script URL; the new URL comes from the environment
  delete config.LOGO_URL;
  const allowedPlans = new Set(plans);

  // ---- Tax rules
  const band = (r: Row) => ({ regime: s(r.Regime), above: n(r.AboveAmount), rate: n(r.RatePercent) });
  const taxRules = {
    slabs: tab('TaxSlabs').map(band),
    surcharge: tab('TaxSurcharge').map(band),
    rules: tab('TaxRules').map((r) => ({ regime: s(r.Regime), rule: s(r.Rule), value: s(r.Value) })),
  };

  // ---- Employees
  const employees: EmployeeDoc[] = [];
  const empIndex = new Map<string, EmployeeDoc>();
  for (const r of tab('Employees')) {
    const id = s(r.EmployeeID).toUpperCase();
    if (!id) {
      skip('employees: no ID');
      continue;
    }
    if (empIndex.has(id)) {
      warnings.push(`Employee ${id} appears twice; the first row was kept.`);
      continue;
    }
    const type = s(r.DematAccountType).toUpperCase();
    const e: EmployeeDoc = {
      employeeId: id,
      name: s(r.Name),
      designation: s(r.Designation),
      stakeholderCategory: s(r.StakeholderCategory),
      accessEmail: s(r.AccessEmail).toLowerCase(),
      secondaryEmail: s(r.SecondaryEmail).toLowerCase(),
      emailOverride: s(r.EmailOverride).toLowerCase(),
      mobile: s(r.Mobile),
      address: s(r.Address),
      nationality: s(r.Nationality) || 'Indian',
      pan: s(r.PAN).toUpperCase(),
      employmentStatus: s(r.EmploymentStatus),
      separationDate: dateKey(r.SeparationDate),
      resignationDate: dateKey(r.ResignationDate),
      ctc: nOrNull(r.CTC),
      taxRatePercent: nOrNull(r.TaxRatePercent),
      blocked: bool(r.Blocked),
      blockedReason: s(r.BlockedReason),
      blockedAt: istInstant(r.BlockedAt),
      blockedBy: s(r.BlockedBy),
      demat: {
        dpName: s(r.DematDPName),
        dpId: s(r.DematDPId).toUpperCase(),
        clientId: s(r.DematClientId),
        accountName: s(r.DematAccountName),
        accountType: type === 'NSDL' || type === 'CDSL' ? type : '',
      },
      remarks: s(r.Remarks),
      updatedAt: istInstant(r.UpdatedAt) || now,
    };
    employees.push(e);
    empIndex.set(id, e);
  }

  // ---- Grants
  const grants: GrantDoc[] = [];
  let totalVested = 0;
  let totalGranted = 0;
  for (const r of tab('Grants')) {
    const grantId = s(r.GrantID);
    const employeeId = s(r.EmployeeID).toUpperCase();
    const planName = s(r.PlanName);
    if (!grantId || !employeeId) {
      skip('grants: no ID');
      continue;
    }
    if (!allowedPlans.has(planName)) {
      skip(`grants: plan "${planName}" not allowed`);
      continue;
    }
    if (!empIndex.has(employeeId)) warnings.push(`Grant ${grantId} belongs to ${employeeId}, who is not on the Employees tab.`);
    let tranches: Tranche[] = [];
    try {
      const raw = s(r.TrancheDetail);
      tranches = raw ? (JSON.parse(raw) as Tranche[]) : [];
    } catch {
      warnings.push(`Grant ${grantId}: tranche detail could not be read.`);
    }
    const g: GrantDoc = {
      grantId,
      employeeId,
      planName,
      multiplier: n(r.Multiplier),
      grantDate: dateKey(r.GrantDate),
      exercisePrice: n(r.ExercisePrice),
      typeOfVesting: s(r.TypeOfVesting),
      grantStatus: s(r.GrantStatus),
      totalGranted: n(r.TotalGranted),
      unvestedOptions: n(r.UnvestedOptions),
      vestedOptions: n(r.VestedOptions),
      exercisedOptions: n(r.ExercisedOptions),
      exercisePendingOptions: n(r.ExercisePendingOptions),
      cancelledOptions: n(r.CancelledOptions),
      trancheCount: n(r.TrancheCount),
      vestedTrancheCount: n(r.VestedTrancheCount),
      nextVestDate: dateKey(r.NextVestDate),
      lastVestDate: dateKey(r.LastVestDate),
      expiryDate: dateKey(r.ExpiryDate),
      tranches,
      reportAsOn: dateKey(r.ReportAsOn),
      lastSyncedAt: istInstant(r.LastSyncedAt) || now,
    };
    totalVested += g.vestedOptions;
    totalGranted += g.totalGranted;
    grants.push(g);
  }

  // ---- FMV
  const fmv: FmvDoc[] = [];
  for (const r of tab('FMV')) {
    const date = dateKey(r.Date);
    if (!date) {
      skip('fmv: no date');
      continue;
    }
    fmv.push({
      date,
      openPrice: n(r.OpenPrice),
      closePrice: n(r.ClosePrice),
      fmv: n(r.FMV),
      source: s(r.Source) || 'Legacy',
      enteredBy: s(r.EnteredBy),
      enteredAt: istInstant(r.EnteredAt) || now,
    });
  }

  // ---- Windows
  const windows: WindowDoc[] = tab('Windows')
    .map((r) => {
      const id = dateKey(r.WindowID).slice(0, 7) || s(r.WindowID).slice(0, 7);
      return {
        windowId: id,
        label: s(r.Label),
        openDate: dateKey(r.OpenDate),
        closeDate: dateKey(r.CloseDate),
        taxDueDate: dateKey(r.TaxDueDate),
        status: (s(r.Status).toLowerCase() === 'closed' ? 'Closed' : 'Open') as WindowDoc['status'],
        createdAt: istInstant(r.CreatedAt) || now,
        closedAt: istInstant(r.ClosedAt),
        remarks: s(r.Remarks),
      };
    })
    .filter((w) => /^\d{4}-\d{2}$/.test(w.windowId));

  // ---- Fund partners
  const partners: FundPartnerDoc[] = tab('FundPartners')
    .filter((r) => s(r.PartnerName))
    .map((r) => ({
      partnerId: partnerIdFor(s(r.PartnerName)),
      name: s(r.PartnerName),
      status: (s(r.Status).toLowerCase() === 'active' ? 'Active' : 'Retired') as FundPartnerDoc['status'],
      contactEmails: emails(r.ContactEmails),
      notes: s(r.Notes),
      createdAt: istInstant(r.CreatedAt) || now,
      createdBy: s(r.CreatedBy),
      updatedAt: istInstant(r.UpdatedAt) || now,
      updatedBy: s(r.UpdatedBy),
    }));
  const partnerByName = new Map(partners.map((p) => [p.name.toLowerCase(), p]));

  // ---- Users (+ secrets kept server-side only)
  const users: UserDoc[] = [];
  const secrets: Record<string, UserSecretDoc> = {};
  for (const r of tab('Users')) {
    const userId = s(r.UserID).toUpperCase();
    const role = s(r.Role) as UserDoc['role'];
    if (!userId || !['Admin', 'Employee', 'FundPartner'].includes(role)) {
      skip('users: bad ID or role');
      continue;
    }
    const emp = role === 'Employee' ? empIndex.get(userId) : undefined;
    if (role === 'Employee' && !emp) warnings.push(`Login ${userId} has no Employees row; it was imported but has no grants.`);
    const loginEmails = Array.from(
      new Set([...emails(r.LoginEmail), ...(emp ? [emp.emailOverride, emp.accessEmail, emp.secondaryEmail] : [])].filter(Boolean)),
    );
    const partner = role === 'FundPartner' ? partnerByName.get(s(r.FundPartnerName).toLowerCase()) : undefined;
    if (role === 'FundPartner' && !partner) warnings.push(`Partner login ${userId} names an unknown partner "${s(r.FundPartnerName)}".`);
    const hash = s(r.PasswordHash);
    users.push({
      userId,
      role,
      name: s(r.Name) || emp?.name || userId,
      loginEmails,
      notifyEmail: (emp && (emp.emailOverride || emp.accessEmail || emp.secondaryEmail)) || emails(r.LoginEmail)[0] || '',
      fundPartnerId: partner?.partnerId,
      fundPartnerName: partner?.name,
      status: s(r.Status).toLowerCase() === 'active' ? 'Active' : 'Disabled',
      mustResetPassword: bool(r.MustResetPassword) || !hash,
      lastLoginAt: istInstant(r.LastLoginAt) || undefined,
      createdAt: istInstant(r.CreatedAt) || now,
      createdBy: s(r.CreatedBy) || 'legacy',
    });
    secrets[userId] = {
      scheme: hash ? 'legacy' : 'none',
      passwordHash: hash,
      legacySalt: s(r.PasswordSalt) || undefined,
      tokenVersion: 1,
      failedAttempts: 0,
    };
  }

  // ---- Tax sheet (payroll's year-to-date position)
  const taxPositions: TaxPositionDoc[] = [];
  for (const r of tab('TaxSheet')) {
    const id = s(r.EmployeeID).toUpperCase();
    if (!id) continue;
    const regime = s(r.Regime);
    taxPositions.push({
      employeeId: id,
      regime: regime === 'New' || regime === 'Old' ? regime : '',
      netTaxable: n(r.NetTaxable),
      totalGross: n(r.TotalGross),
      projectedGross: n(r.ProjectedGross),
      totalTax: n(r.TotalTax),
      previousTds: n(r.PreviousTDS),
      outsideTax: n(r.OutsideTax),
      tdsToDate: n(r.TDSToDate),
      remainingMonths: n(r.RemainingMonths),
      asOn: dateKey(r.AsOn),
      loadedAt: istInstant(r.LoadedAt) || now,
      loadedBy: s(r.LoadedBy),
      flags: s(r.Flags).split(/[\s,;]+/).filter(Boolean),
      engineTotal: n(r.EngineTotal),
    });
  }

  // ---- Audit history (kept for the record)
  const audit: AuditDoc[] = tab('AuditLog').map((r) => ({
    at: istInstant(r.Timestamp) || now,
    actor: s(r.Actor),
    role: (['Admin', 'Employee', 'FundPartner'].includes(s(r.Role)) ? s(r.Role) : 'system') as AuditDoc['role'],
    action: `LEGACY_${s(r.Action)}`,
    appId: s(r.AppID),
    details: s(r.Details).slice(0, 4000),
  }));
  audit.push({ at: now, actor: importedBy, role: 'system', action: 'LEGACY_IMPORT', appId: '', details: 'Imported from the Apps Script workbook' });

  for (const t of ['Applications', 'ApplicationLines', 'TaxPayments', 'FundPartnerRequests']) skipped[`${t} (test data, not imported)`] = tab(t).length;

  return {
    config,
    taxRules,
    users,
    secrets,
    employees,
    grants,
    fmv,
    windows,
    partners,
    taxPositions,
    audit,
    report: {
      counts: {
        settings: Object.keys(config).length,
        users: users.length,
        employees: employees.length,
        grants: grants.length,
        fmvPrices: fmv.length,
        windows: windows.length,
        fundPartners: partners.length,
        taxPositions: taxPositions.length,
        auditHistory: audit.length,
      },
      skipped,
      totals: { totalGranted, totalVested },
      warnings: warnings.slice(0, 200),
    },
  };
}
