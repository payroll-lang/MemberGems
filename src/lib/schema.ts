/**
 * Firestore data model.
 *
 * Field names are the legacy sheet headings in lowerCamelCase, so the import
 * from the sheet is mechanical and reports line up with the old export.
 * Dates are 'yyyy-MM-dd' strings (Asia/Kolkata); timestamps are ISO strings.
 * Money is a number in rupees.
 *
 * Nothing in Firestore is readable by the browser: security rules deny all
 * client access and every read goes through the server, which checks the role.
 */

export const COL = {
  settings: 'settings', // doc 'portal' (Config tab), doc 'taxRules' (tax tabs), doc 'holidays'
  users: 'users', // id = userId (upper-case)
  userSecrets: 'userSecrets', // id = userId — password hash, codes. Never returned to a client.
  sessions: 'sessions', // id = sha256(session token)
  rateLimits: 'rateLimits',
  employees: 'employees', // id = employeeId
  grants: 'grants', // id = grantId, field employeeId
  fmv: 'fmvPrices', // id = 'yyyy-MM-dd'
  windows: 'windows', // id = 'yyyy-MM'
  applications: 'applications', // id = appId; sub-collections 'lines', 'taxPayments'
  fundPartners: 'fundPartners', // id = slug of name
  partnerRequests: 'partnerRequests', // id = requestId
  taxPositions: 'taxPositions', // id = employeeId (TaxSheet tab)
  auditLog: 'auditLog',
  emailLog: 'emailLog', // id = dedupe key when the email must go only once
  files: 'files', // id = fileId; metadata for objects in Cloud Storage
} as const;

export type Role = 'Admin' | 'Employee' | 'FundPartner';
export type UserStatus = 'Active' | 'Disabled';

export interface UserDoc {
  userId: string;
  role: Role;
  name: string;
  /** Every address this user may sign in with, lower-cased. */
  loginEmails: string[];
  /** Address for notifications. */
  notifyEmail: string;
  fundPartnerId?: string;
  fundPartnerName?: string;
  status: UserStatus;
  mustResetPassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
  createdBy: string;
}

export interface UserSecretDoc {
  /** 'argon2' for new hashes; 'legacy' for hashes imported from Apps Script. */
  scheme: 'argon2' | 'legacy' | 'none';
  passwordHash: string;
  /** Legacy scheme only: the per-user salt from the sheet. */
  legacySalt?: string;
  /** Raised to sign the user out everywhere. */
  tokenVersion: number;
  failedAttempts: number;
  lockedUntil?: string;
  code?: { hash: string; expiresAt: string; attempts: number; purpose: 'invite' | 'reset' };
}

export interface SessionDoc {
  userId: string;
  role: Role;
  tokenVersion: number;
  createdAt: string;
  expiresAt: string;
  ip?: string;
  userAgent?: string;
}

export interface EmployeeDoc {
  employeeId: string;
  name: string;
  designation: string;
  stakeholderCategory: string;
  accessEmail: string;
  secondaryEmail: string;
  emailOverride: string;
  mobile: string;
  address: string;
  nationality: string;
  pan: string;
  employmentStatus: string;
  separationDate: string;
  resignationDate: string;
  ctc: number | null;
  taxRatePercent: number | null;
  blocked: boolean;
  blockedReason: string;
  blockedAt: string;
  blockedBy: string;
  demat: DematDetails;
  remarks: string;
  updatedAt: string;
}

export interface DematDetails {
  dpName: string;
  dpId: string;
  clientId: string;
  accountName: string;
  accountType: '' | 'NSDL' | 'CDSL';
}

export interface Tranche {
  id: string;
  vd: string; // vest date
  avd: string; // actual vest date
  v: number; // vested
  u: number; // unvested
  e: number; // exercised
  p: number; // exercise pending
}

export interface GrantDoc {
  grantId: string;
  employeeId: string;
  planName: string;
  multiplier: number;
  grantDate: string;
  exercisePrice: number;
  typeOfVesting: string;
  grantStatus: string;
  totalGranted: number;
  unvestedOptions: number;
  vestedOptions: number;
  exercisedOptions: number;
  exercisePendingOptions: number;
  cancelledOptions: number;
  trancheCount: number;
  vestedTrancheCount: number;
  nextVestDate: string;
  lastVestDate: string;
  expiryDate: string;
  tranches: Tranche[];
  reportAsOn: string;
  lastSyncedAt: string;
}

export interface FmvDoc {
  date: string;
  openPrice: number;
  closePrice: number;
  fmv: number;
  source: string;
  enteredBy: string;
  enteredAt: string;
}

export type WindowStatus = 'Open' | 'Closed';
export interface WindowDoc {
  windowId: string;
  label: string;
  openDate: string;
  closeDate: string;
  taxDueDate: string;
  status: WindowStatus;
  createdAt: string;
  closedAt: string;
  remarks: string;
}

export type AppStatus = 'Draft' | 'Submitted' | 'Under Review' | 'Sent Back' | 'Approved' | 'Rejected';
export type ReviewState = 'Pending' | 'Verified' | 'Sent Back';
export type SectionKey = 'options' | 'demat' | 'exercisePayment' | 'taxPayment' | 'notice';

export interface ApplicationDoc {
  appId: string;
  windowId: string;
  employeeId: string;
  status: AppStatus;
  totalOptions: number;
  totalShares: number;
  exercisePrice: number;
  exerciseAmount: number;
  fmvDate: string;
  fmvValue: number;
  perquisiteAmount: number;
  taxRatePercent: number;
  taxAmount: number;
  taxMethod: '' | 'Sheet' | 'Flat' | 'None';
  taxBreakdown: unknown;
  /** Set on submission; the tax is not repriced after this without an admin action. */
  taxFrozenAt: string;
  applicant: { address: string; nationality: string; mobile: string; designation: string; pan: string };
  demat: DematDetails;
  dematSource: string;
  cmlFileId: string;
  panFileId: string;
  exercisePayment: { utr: string; date: string; amount: number; bank: string; proofFileId: string };
  taxMode: '' | 'Self' | 'FundPartner';
  fundPartnerId: string;
  fundPartnerName: string;
  taxDueDate: string;
  taxPaidAmount: number;
  taxPaymentCount: number;
  notice: { signatureName: string; signedAt: string; place: string; fileId: string };
  review: Record<SectionKey, ReviewState>;
  adminRemarks: { at: string; by: string; section?: SectionKey; text: string }[];
  reviewedBy: string;
  reviewedAt: string;
  approvedAt: string;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency counter, raised on every write. */
  rev: number;
}

export interface ApplicationLineDoc {
  lineId: string;
  grantId: string;
  planName: string;
  multiplier: number;
  optionsExercised: number;
  sharesAllotted: number;
  exercisePrice: number;
  lineExerciseAmount: number;
  perquisitePerShare: number;
  linePerquisite: number;
  updatedAt: string;
}

export interface TaxPaymentDoc {
  paymentId: string;
  appId: string;
  employeeId: string;
  seq: number;
  paidBy: 'Self' | 'FundPartner';
  fundPartnerName: string;
  utr: string;
  paymentDate: string;
  amount: number;
  bank: string;
  proofFileId: string;
  enteredBy: string;
  enteredAt: string;
  remarks: string;
}

export interface FundPartnerDoc {
  partnerId: string;
  name: string;
  status: 'Active' | 'Retired';
  contactEmails: string[];
  notes: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type PartnerRequestStatus = 'Assigned' | 'Payment Fed' | 'Verified' | 'Sent Back' | 'Declined' | 'Withdrawn';

export interface PartnerRequestDoc {
  requestId: string;
  appId: string;
  employeeId: string;
  fundPartnerId: string;
  fundPartnerName: string;
  taxAmount: number;
  status: PartnerRequestStatus;
  assignedAt: string;
  payment: { utr: string; date: string; amount: number; bank: string; proofFileId: string };
  fedBy: string;
  fedAt: string;
  remarks: string;
  partnerDemat: DematDetails & { cmlFileId: string; providedBy: string; providedAt: string };
  /** The participant's own account before the partner's replaced it. */
  employeeDemat: (DematDetails & { cmlFileId: string }) | null;
}

export interface TaxPositionDoc {
  employeeId: string;
  regime: 'New' | 'Old' | '';
  netTaxable: number;
  totalGross: number;
  projectedGross: number;
  totalTax: number;
  previousTds: number;
  outsideTax: number;
  tdsToDate: number;
  remainingMonths: number;
  asOn: string;
  loadedAt: string;
  loadedBy: string;
  flags: string[];
  engineTotal: number;
}

export interface AuditDoc {
  at: string;
  actor: string;
  role: Role | 'system';
  action: string;
  appId: string;
  details: string;
}

export interface FileDoc {
  fileId: string;
  ownerEmployeeId: string;
  appId: string;
  label: string;
  storagePath: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  /** Superseded files are kept (never deleted) for the audit trail. */
  supersededAt: string;
}
