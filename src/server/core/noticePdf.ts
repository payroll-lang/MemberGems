/**
 * The exercise notice as a PDF, drawn with pdf-lib (pure JavaScript, no
 * browser or native binary, so it runs on Vercel's Node runtime).
 *
 * It is laid out from the same NoticeModel as the on-screen HTML, so the
 * wording and figures are identical. The standard PDF fonts cannot encode
 * "₹" (or scripts other than Latin), so the PDF writes "Rs." for the rupee
 * sign and replaces any other character it cannot encode with "?". The
 * on-screen notice keeps the original text.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { count, inr } from '@/domain';
import { NOTICE_TEXT, sectionBLines, type NoticeModel } from './notice';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const INK = rgb(0.078, 0.129, 0.11);
const DIM = rgb(0.29, 0.36, 0.33);
const RULE = rgb(0.76, 0.79, 0.75);
const SHADE = rgb(0.94, 0.95, 0.925);

interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont; script: PDFFont }
interface Seg { text: string; font: PDFFont; color?: ReturnType<typeof rgb> }

const encodable = new WeakMap<PDFFont, Map<string, boolean>>();

/** Text the font can draw: ₹ → Rs., anything unencodable → ?. */
export function pdfSafe(text: string, font: PDFFont): string {
  let cache = encodable.get(font);
  if (!cache) { cache = new Map(); encodable.set(font, cache); }
  const src = String(text ?? '').replace(/₹\s?/g, 'Rs. ').replace(/ /g, ' ').replace(/[\t\r]/g, ' ');
  let out = '';
  for (const ch of src) {
    if (ch === '\n') { out += ch; continue; }
    let ok = cache.get(ch);
    if (ok === undefined) {
      try { font.encodeText(ch); font.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; }
      cache.set(ch, ok);
    }
    out += ok ? ch : '?';
  }
  return out;
}

class Writer {
  doc: PDFDocument;
  fonts: Fonts;
  page!: PDFPage;
  y = 0;
  width = A4[0] - 2 * MARGIN;

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }

  gap(h: number) { this.y -= h; }

  /** Word-wrap segments of mixed fonts into lines of at most `width`. */
  wrap(segs: Seg[], size: number, width: number): Seg[][] {
    type Tok = { text: string; font: PDFFont; color?: ReturnType<typeof rgb>; space: boolean; br?: boolean };
    const toks: Tok[] = [];
    segs.forEach((s) => {
      const safe = pdfSafe(s.text, s.font);
      safe.split(/(\n| )/).forEach((p) => {
        if (p === '\n') toks.push({ text: '', font: s.font, space: false, br: true });
        else if (p === ' ') toks.push({ text: ' ', font: s.font, color: s.color, space: true });
        else if (p) toks.push({ text: p, font: s.font, color: s.color, space: false });
      });
    });
    const lines: Seg[][] = [];
    let line: Seg[] = [];
    let w = 0;
    const push = () => {
      while (line.length && line[line.length - 1].text === ' ') line.pop();
      lines.push(line); line = []; w = 0;
    };
    for (const t of toks) {
      if (t.br) { push(); continue; }
      if (t.space && !line.length) continue;
      let tw = t.font.widthOfTextAtSize(t.text, size);
      if (!t.space && w + tw > width && line.length) push();
      // A single word wider than the line is broken by character.
      if (!t.space && tw > width) {
        let chunk = '';
        for (const ch of t.text) {
          const cw = t.font.widthOfTextAtSize(chunk + ch, size);
          if (cw > width && chunk) { line.push({ text: chunk, font: t.font, color: t.color }); push(); chunk = ''; }
          chunk += ch;
        }
        tw = t.font.widthOfTextAtSize(chunk, size);
        line.push({ text: chunk, font: t.font, color: t.color });
        w += tw;
        continue;
      }
      line.push({ text: t.text, font: t.font, color: t.color });
      w += tw;
    }
    if (line.length) push();
    return lines.length ? lines : [[]];
  }

  drawLine(segs: Seg[], x: number, y: number, size: number) {
    let cx = x;
    segs.forEach((s) => {
      if (!s.text) return;
      this.page.drawText(s.text, { x: cx, y, size, font: s.font, color: s.color ?? INK });
      cx += s.font.widthOfTextAtSize(s.text, size);
    });
  }

  lineWidth(segs: Seg[], size: number): number {
    return segs.reduce((a, s) => a + s.font.widthOfTextAtSize(s.text, size), 0);
  }

  para(segs: Seg[] | string, opts: { size?: number; indent?: number; after?: number; center?: boolean; bullet?: string } = {}) {
    const size = opts.size ?? 10;
    const lead = size * 1.4;
    const indent = opts.indent ?? 0;
    const list = typeof segs === 'string' ? [{ text: segs, font: this.fonts.regular }] : segs;
    const lines = this.wrap(list, size, this.width - indent);
    lines.forEach((l, i) => {
      this.ensure(lead);
      this.y -= size;
      let x = MARGIN + indent;
      if (opts.center) x = MARGIN + (this.width - this.lineWidth(l, size)) / 2;
      if (opts.bullet && i === 0) this.page.drawText(opts.bullet, { x: MARGIN + indent - 10, y: this.y, size, font: this.fonts.regular, color: INK });
      this.drawLine(l, x, this.y, size);
      this.y -= lead - size;
    });
    this.y -= opts.after ?? 6;
  }

  heading(text: string, size = 10.5) {
    this.ensure(size * 3);
    this.gap(8);
    this.para([{ text, font: this.fonts.bold }], { size, after: 4 });
  }

  /**
   * A bordered table. `cols` are fractions of the width; `align` per column.
   * Header and footer rows are shaded and bold.
   */
  table(cols: number[], header: string[] | null, body: string[][], opts: { align?: ('l' | 'r')[]; footer?: string[]; boldCol?: number; dimCol?: number } = {}) {
    const size = 9;
    const pad = 4;
    const widths = cols.map((c) => c * this.width);
    const row = (cells: string[], kind: 'head' | 'body' | 'foot') => {
      const wrapped = cells.map((c, i) => this.wrap([{
        text: c,
        font: kind !== 'body' || i === opts.boldCol ? this.fonts.bold : this.fonts.regular,
        color: kind === 'body' && i === opts.dimCol ? DIM : INK,
      }], size, widths[i] - 2 * pad));
      const h = Math.max(...wrapped.map((w) => w.length)) * size * 1.3 + 2 * pad;
      this.ensure(h);
      let x = MARGIN;
      const top = this.y;
      wrapped.forEach((lines, i) => {
        this.page.drawRectangle({
          x, y: top - h, width: widths[i], height: h,
          borderColor: kind === 'head' ? INK : RULE, borderWidth: 0.6,
          color: kind === 'body' ? undefined : SHADE,
        });
        lines.forEach((l, li) => {
          const ly = top - pad - size - li * size * 1.3 + 1.5;
          const right = (opts.align?.[i] ?? 'l') === 'r';
          const lx = right ? x + widths[i] - pad - this.lineWidth(l, size) : x + pad;
          this.drawLine(l, lx, ly, size);
        });
        x += widths[i];
      });
      this.y = top - h;
    };
    if (header) row(header, 'head');
    body.forEach((r) => row(r, 'body'));
    if (opts.footer) row(opts.footer, 'foot');
    this.y -= 10;
  }
}

/** Render the notice model to PDF bytes. */
export async function renderNoticePdf(m: NoticeModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Exercise Notice — ' + m.appId);
  doc.setAuthor(m.signature?.name ?? m.companyName);
  doc.setSubject('ESOP exercise notice');
  doc.setProducer('ESOP Exercise Portal');
  doc.setCreator('ESOP Exercise Portal');
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    script: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
  };
  const w = new Writer(doc, fonts);
  const T = NOTICE_TEXT;
  const R = (text: string): Seg => ({ text, font: fonts.regular });
  const B = (text: string): Seg => ({ text, font: fonts.bold });
  const I = (text: string): Seg => ({ text, font: fonts.italic, color: DIM });

  w.para([B(T.title)], { size: 14, center: true, after: 14 });
  w.para([R('To,\n'), B(m.companyName),
    ...(m.formerName ? [R('\n(' + m.formerName + ')')] : []),
    ...(m.companyAddress ? [R('\nAdd: ' + m.companyAddress)] : [])], { after: 10 });
  w.para([B(T.subject)], { after: 8 });
  w.para(T.salutation);
  w.para(T.intro);

  w.heading(T.sectionA);
  w.table([0.38, 0.62], ['Particulars', 'Details'], m.personal.map(([k, v]) => [k, v || '—']), { boldCol: 1, dimCol: 0 });

  w.heading(T.sectionB);
  sectionBLines(m).forEach(([k, v, tail]) => w.para([R(k), B(v), I(tail)], { after: 3 }));
  w.gap(4);

  if (m.showShares && m.rows.length) {
    w.para([B('GRANT-WISE BREAKDOWN')], { size: 8.5, after: 2 });
    const multi = m.rows.some((r) => Math.abs(r.multiplier - 1) > 1e-9);
    const cols = multi ? [0.22, 0.2, 0.13, 0.13, 0.14, 0.18] : [0.25, 0.25, 0.15, 0.15, 0.2];
    const head = multi
      ? ['Grant ID', 'Plan', 'Options', 'Conversion', 'Equity shares', 'Exercise amount']
      : ['Grant ID', 'Plan', 'Options', 'Equity shares', 'Exercise amount'];
    const align: ('l' | 'r')[] = multi ? ['l', 'l', 'r', 'r', 'r', 'r'] : ['l', 'l', 'r', 'r', 'r'];
    const body = m.rows.map((r) => [
      r.grantId + (r.grantDate ? '\ngranted ' + r.grantDate : ''), r.planName, count(r.options),
      ...(multi ? ['x ' + r.multiplier] : []), count(r.shares), inr(r.amount),
    ]);
    const foot = ['Total', '', count(m.rows.reduce((a, r) => a + r.options, 0)), ...(multi ? [''] : []),
      count(m.rows.reduce((a, r) => a + r.shares, 0)), inr(m.rows.reduce((a, r) => a + r.amount, 0))];
    w.table(cols, head, body, { align, footer: foot });
  }

  w.para(T.agreePay);
  w.para(T.requestAllot);

  w.heading(T.sectionC);
  w.para(T.bankIntro);
  if (m.bank.pairs.length) w.table([0.38, 0.62], ['Particulars', 'Details'], m.bank.pairs, { boldCol: 1, dimCol: 0 });
  if (m.bank.loose.length) w.para(m.bank.loose.join('\n'));

  w.para([B(T.instructionsHead)], { after: 3 });
  T.instructions(m.paymentReference).forEach((x) => w.para(x, { indent: 14, bullet: '•', after: 3 }));

  // Signature block.
  w.gap(14);
  const s = m.signature;
  const boxH = s ? 150 : 40;
  w.ensure(boxH + 10);
  const top = w.y;
  if (s) {
    const rowAt = (label: string, value: Seg, dy: number, size = 10) => {
      w.page.drawText('' + label, { x: MARGIN + 14, y: top - dy, size: 10, font: fonts.regular, color: DIM });
      w.drawLine([value], MARGIN + 100, top - dy, size);
    };
    rowAt('Name:', B(pdfSafe(s.name, fonts.bold)), 22);
    rowAt('Signature:', { text: pdfSafe(s.signatureName, fonts.script), font: fonts.script, color: rgb(0.08, 0.2, 0.16) }, 50, 20);
    w.page.drawLine({ start: { x: MARGIN + 98, y: top - 55 }, end: { x: MARGIN + 340, y: top - 55 }, thickness: 0.6, color: INK });
    rowAt('Date:', B(pdfSafe(s.signingDate, fonts.bold)), 74);
    rowAt('Place:', B(pdfSafe(s.place, fonts.bold)), 92);
    w.y = top - 104;
    const saveWidth = w.width;
    w.width = saveWidth - 28;
    const lines = w.wrap([{ text: T.attest(m), font: fonts.regular, color: DIM }], 8, w.width);
    lines.forEach((l) => { w.y -= 8; w.drawLine(l, MARGIN + 14, w.y, 8); w.y -= 3.5; });
    w.width = saveWidth;
    const h = top - w.y + 10;
    w.page.drawRectangle({ x: MARGIN, y: top - h, width: w.width, height: h, borderColor: INK, borderWidth: 0.8 });
    w.y = top - h;
  } else {
    w.page.drawRectangle({ x: MARGIN, y: top - boxH, width: w.width, height: boxH, borderColor: rgb(0.66, 0.45, 0.1), borderWidth: 0.8, borderDashArray: [3, 3] });
    w.page.drawText(pdfSafe(T.unsigned, fonts.regular), { x: MARGIN + 14, y: top - 24, size: 9.5, font: fonts.regular, color: DIM });
    w.y = top - boxH;
  }

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = pdfSafe(m.appId + ' · page ' + (i + 1) + ' of ' + pages.length, fonts.regular);
    p.drawText(label, { x: MARGIN, y: 26, size: 7.5, font: fonts.regular, color: DIM });
  });

  return doc.save();
}
