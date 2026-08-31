import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Machida Shoten Cambodia — Yokohama Style Ramen',
  description:
    'Machida Shoten Cambodia — an exclusive QR experience and a visual introduction to Yokohama Style Ramen.',
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
