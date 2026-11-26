/** Types shared by the admin server actions and the client forms. */
import type { FormResult } from '@/components/useFormAction';

export interface AdminResult extends FormResult {
  data?: unknown;
}

export interface IssuedCodeView {
  userId: string;
  name: string;
  email: string;
  emailed: boolean;
  code: string;
  expiresInMinutes: number;
}
