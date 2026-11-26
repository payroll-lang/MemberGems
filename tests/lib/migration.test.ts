import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { dateKey, istInstant, parseWorkbook, partnerIdFor } from '../../src/lib/migration/parse';

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const add = (name: string, rows: unknown[][]) => wb.addWorksheet(name).addRows(rows);
  add('Config', [['Key', 'Value', 'Notes'], ['COMPANY_NAME', 'Acme Ltd', ''], ['ALLOWED_PLANS', 'ESOP Plan 2022, ESOP Plan 2025, Test Plan', ''], ['PORTAL_URL', 'https://script.google.com/x', '']]);
  add('TaxSlabs', [['Regime', 'AboveAmount', 'RatePercent', 'Note'], ['New', 0, 0, ''], ['New', 400000, 5, '']]);
  add('TaxSurcharge', [['Regime', 'AboveAmount', 'RatePercent', 'Note'], ['New', 5000000, 10, '']]);
  add('TaxRules', [['Regime', 'Rule', 'Value', 'Note'], ['New', 'CessPercent', 4, '']]);
  add('Employees', [
    ['EmployeeID', 'Name', 'AccessEmail', 'SecondaryEmail', 'EmailOverride', 'PAN', 'Blocked', 'DematAccountType', 'UpdatedAt'],
    ['e100', 'Test One', 'One@Example.com', '', '', 'abcde1234f', 'TRUE', 'nsdl', new Date('2026-09-08T18:42:48Z')],
    ['E101', 'Test Two', 'two@example.com', '', 'two.personal@example.com', '', '', '', ''],
  ]);
  add('Grants', [
    ['GrantID', 'EmployeeID', 'PlanName', 'Multiplier', 'GrantDate', 'ExercisePrice', 'VestedOptions', 'TotalGranted', 'TrancheDetail', 'ReportAsOn'],
    ['EA-1', 'E100', 'ESOP Plan 2022', 3.6, new Date('2025-01-01T00:00:00Z'), 1, 100, 400, '[{"id":"t1","vd":"2026-01-01","avd":"","v":100,"u":300,"e":0,"p":0}]', new Date('2026-09-08T00:00:00Z')],
    ['EA-2', 'E101', 'Test Plan', 3.6, '', 1, 50, 50, '', ''],
  ]);
  add('FMV', [['Date', 'OpenPrice', 'ClosePrice', 'FMV', 'Source', 'EnteredBy', 'EnteredAt'], [new Date('2026-03-04T00:00:00Z'), '₹ 79.99', '₹ 79.56', '₹ 79.78', 'Manual', 'K', '']]);
  add('Windows', [['WindowID', 'Label', 'OpenDate', 'CloseDate', 'TaxDueDate', 'Status'], ['2026-11', new Date('2026-11-01T00:00:00Z'), '2026-11-01', '2026-11-30', '2026-12-25', 'Open']]);
  add('FundPartners', [['PartnerName', 'Status', 'ContactEmails'], ['Funds India with Bajaj', 'Active', 'a@x.com, b@x.com']]);
  add('Users', [
    ['UserID', 'Role', 'Name', 'LoginEmail', 'FundPartnerName', 'PasswordSalt', 'PasswordHash', 'Status', 'MustResetPassword'],
    ['e100', 'Employee', 'Test One', 'one@example.com', '', 'salt', 'r200$abc=', 'Active', 'FALSE'],
    ['FP-X', 'FundPartner', 'Partner', 'p@x.com', 'Funds India with Bajaj', '', '', 'Active', ''],
  ]);
  add('TaxSheet', [['EmployeeID', 'Regime', 'NetTaxable', 'AsOn'], ['E100', 'New', '1,00,000', '2026-10-24']]);
  add('AuditLog', [['Timestamp', 'Actor', 'Role', 'Action', 'AppID', 'Details'], ['2026-09-08 16:25:47', 'setup', 'Admin', 'USER_CREATED', '', 'x']]);
  add('Applications', [['AppID'], ['APP-1']]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('legacy workbook import', () => {
  it('maps every tab and drops test data', async () => {
    const p = await parseWorkbook(await workbook(), 'test');
    expect(p.config.ALLOWED_PLANS).toBe('ESOP Plan 2022, ESOP Plan 2025');
    expect(p.config.PORTAL_URL).toBeUndefined();
    expect(p.config.FLAT_TAX_ROUNDING).toBe('rupee');
    expect(p.config.EMAILS_ENABLED).toBe('false');
    expect(p.config.BULK_EMAILS_ENABLED).toBe('false');
    expect(p.employees.map((e) => e.employeeId)).toEqual(['E100', 'E101']);
    expect(p.employees[0]).toMatchObject({ accessEmail: 'one@example.com', pan: 'ABCDE1234F', blocked: true, demat: { accountType: 'NSDL' } });
    expect(p.grants).toHaveLength(1);
    expect(p.grants[0]).toMatchObject({ grantId: 'EA-1', multiplier: 3.6, grantDate: '2025-01-01', reportAsOn: '2026-09-08' });
    expect(p.grants[0].tranches[0].u).toBe(300);
    expect(p.report.skipped['grants: plan "Test Plan" not allowed']).toBe(1);
    expect(p.report.skipped['Applications (test data, not imported)']).toBe(1);
    expect(p.fmv[0]).toMatchObject({ date: '2026-03-04', openPrice: 79.99, closePrice: 79.56, fmv: 79.78 });
    expect(p.windows[0]).toMatchObject({ windowId: '2026-11', label: 'November 2026', status: 'Open', taxDueDate: '2026-12-25' });
    expect(p.partners[0]).toMatchObject({ partnerId: 'FUNDS-INDIA-WITH-BAJAJ', contactEmails: ['a@x.com', 'b@x.com'] });
    const [emp, fp] = p.users;
    expect(emp).toMatchObject({ userId: 'E100', role: 'Employee', loginEmails: ['one@example.com'], mustResetPassword: false });
    expect(p.secrets.E100).toMatchObject({ scheme: 'legacy', passwordHash: 'r200$abc=', legacySalt: 'salt' });
    expect(fp).toMatchObject({ fundPartnerId: 'FUNDS-INDIA-WITH-BAJAJ', mustResetPassword: true });
    expect(p.secrets['FP-X'].scheme).toBe('none');
    expect(p.taxPositions[0]).toMatchObject({ employeeId: 'E100', regime: 'New', netTaxable: 100000, asOn: '2026-10-24' });
    expect(p.audit[0]).toMatchObject({ action: 'LEGACY_USER_CREATED', at: '2026-09-08T10:55:47.000Z' });
  });

  it('reads dates and IST timestamps', () => {
    expect(dateKey(new Date('2026-03-04T00:00:00Z'))).toBe('2026-03-04');
    expect(dateKey('2026-03-04')).toBe('2026-03-04');
    expect(dateKey('-')).toBe('');
    expect(istInstant('2026-09-08 16:25:47')).toBe('2026-09-08T10:55:47.000Z');
    expect(partnerIdFor('Funds India with Infina Finance Pvt Ltd')).toBe('FUNDS-INDIA-WITH-INFINA-FINANCE-PVT-LTD');
  });

  it('rejects a workbook without a Config tab', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Other').addRow(['x']);
    await expect(parseWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), 't')).rejects.toThrow(/Config/);
  });
});
