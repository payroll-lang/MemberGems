import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono, Newsreader } from 'next/font/google';
import './globals.css';

const sans = Archivo({ variable: '--font-sans', subsets: ['latin'] });
const serif = Newsreader({ variable: '--font-serif', subsets: ['latin'] });
const mono = IBM_Plex_Mono({ variable: '--font-mono', subsets: ['latin'], weight: ['400', '500'] });

export const metadata: Metadata = {
  title: 'ESOP Exercise Portal',
  description: 'Physicswallah Limited ESOP exercise portal',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en-IN" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
