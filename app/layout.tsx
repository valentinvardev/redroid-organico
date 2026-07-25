import './globals.css';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

export const metadata: Metadata = {
  title: 'Redroid Organico',
  description: 'Automated publishing pipeline for the app under test',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Self-hosted by next/font, so no request leaves the page at runtime. The
    // stylesheet falls back to a system stack if the package is ever absent.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
