import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Machida Shoten Cambodia — Iekei Ramen',
  description:
    'Machida Shoten Cambodia — an exclusive QR offer and a visual introduction to Iekei ramen.',
  robots: 'noindex, nofollow',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
