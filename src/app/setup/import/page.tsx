import { ImportForm } from './form';

export const metadata = { title: 'Data import · ESOP Exercise Portal' };

export default function ImportPage() {
  return (
    <main className="auth-wrap">
      <section className="card" style={{ maxWidth: 560 }}>
        <h1>Import from the old portal</h1>
        <p className="muted small">
          Open the sheet “ESOP Exercise Portal — Data”, choose File → Download → Microsoft Excel (.xlsx), and upload that file here.
          Run “Check only” first. Test applications and the Test Plan are not imported.
        </p>
        <ImportForm />
      </section>
    </main>
  );
}
