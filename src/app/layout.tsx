import type { Metadata } from "next";
import { Geist, Geist_Mono, Cairo } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Lilo Cafe and Restaurant — Restaurant Management System",
  description:
    "Complete restaurant management: POS with split payments, kitchen display system, inventory with recipe-based stock control, and sales analytics.",
  keywords: ["restaurant", "POS", "KDS", "inventory", "RMS", "Next.js"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cairo.variable} antialiased bg-background text-foreground font-[family-name:var(--font-geist-sans)] rtl:font-[family-name:var(--font-cairo)]`}
      >
        {children}
      </body>
    </html>
  );
}
