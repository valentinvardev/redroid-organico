import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Redroid Organico – TikTok MVP',
  description: 'Starter app for a TikTok publishing pipeline',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
