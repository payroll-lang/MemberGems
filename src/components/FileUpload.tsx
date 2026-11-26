'use client';

import { useId, useState } from 'react';
import type { FilePurpose } from '@/lib/schema';

const MAX_MB = 8;
const TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export interface CurrentFile {
  fileId: string;
  name: string;
  sizeKb: number;
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'done'; name: string; fileId: string }
  | { kind: 'error'; text: string };

/**
 * A document upload that goes straight from the browser to private Cloud
 * Storage: ask the server for a signed URL, PUT the file to it, then have the
 * server check what arrived. The resulting file id travels with the form in
 * a hidden input named `name`; the save action attaches it.
 */
export function FileUpload(props: {
  name: string;
  purpose: FilePurpose;
  appId: string;
  requestId?: string;
  label: string;
  hint?: string;
  current?: CurrentFile | null;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function upload(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const type = (file.type === 'image/jpg' ? 'image/jpeg' : file.type) || TYPES[ext] || '';
    if (!Object.values(TYPES).includes(type)) {
      setState({ kind: 'error', text: 'Upload a PDF, JPG or PNG file.' });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setState({ kind: 'error', text: 'That file is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is ' + MAX_MB + ' MB — please compress it or upload a smaller scan.' });
      return;
    }
    try {
      setState({ kind: 'busy', text: 'Preparing the upload…' });
      const t = await fetch('/api/files/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: props.purpose, appId: props.appId, requestId: props.requestId, contentType: type, size: file.size, name: file.name }),
      }).then((r) => r.json() as Promise<{ ok: boolean; error?: string; fileId?: string; url?: string; headers?: Record<string, string> }>);
      if (!t.ok || !t.url || !t.fileId) throw new Error(t.error || 'The upload could not be started.');
      setState({ kind: 'busy', text: 'Uploading ' + file.name + '…' });
      const put = await fetch(t.url, { method: 'PUT', headers: t.headers, body: file });
      if (!put.ok) throw new Error('The upload did not complete (' + put.status + '). Please try again.');
      setState({ kind: 'busy', text: 'Checking the file…' });
      const c = await fetch('/api/files/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: t.fileId }),
      }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
      if (!c.ok) throw new Error(c.error || 'The file could not be checked.');
      setState({ kind: 'done', name: file.name, fileId: t.fileId });
    } catch (e) {
      setState({ kind: 'error', text: (e as Error).message || 'The upload failed. Please try again.' });
    }
  }

  const current = props.current;
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label} {props.required ? <span className="req">required</span> : null}
      </label>
      {current && state.kind !== 'done' ? (
        <p className="small">
          <span className="pill ok">On file</span>{' '}
          <a href={'/api/files/' + encodeURIComponent(current.fileId) + '?inline=1'} target="_blank" rel="noopener noreferrer">{current.name}</a>
          <span className="dim"> ({current.sizeKb} KB) — choose a file below only to replace it.</span>
        </p>
      ) : null}
      <input
        id={id}
        type="file"
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        disabled={props.disabled || state.kind === 'busy'}
        onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void upload(f); }}
        aria-describedby={id + '-status'}
      />
      <input type="hidden" name={props.name} value={state.kind === 'done' ? state.fileId : ''} />
      <div id={id + '-status'} className="hint" aria-live="polite">
        {state.kind === 'busy' ? state.text : null}
        {state.kind === 'done' ? <span className="ok-text">Uploaded: {state.name}. It is attached when you save.</span> : null}
        {state.kind === 'error' ? <span className="err-text">{state.text}</span> : null}
        {state.kind === 'idle' && props.hint ? props.hint : null}
      </div>
    </div>
  );
}
