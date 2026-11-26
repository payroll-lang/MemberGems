'use client';

import { importTicketAction } from '../actions';

/** Upload a report file straight to private storage; returns the stored path. */
export async function uploadImport(kind: 'grantReport' | 'taxSheet', file: File, onStatus: (s: string) => void): Promise<string> {
  onStatus('Preparing the upload…');
  const t = await importTicketAction(kind, file.name, file.size);
  if (!t.ok) throw new Error(t.error || 'The upload could not be started.');
  onStatus('Uploading ' + file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)…');
  const res = await fetch(t.ticket.url, { method: 'PUT', headers: t.ticket.headers, body: file });
  if (!res.ok) throw new Error('The upload failed (' + res.status + '). Try again.');
  return t.ticket.path;
}
