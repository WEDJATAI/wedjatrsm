import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Cairo } from "next/font/google";
import "./globals.css";
// R21: in-app auto-snapshot watcher (side-effect import — do not remove)
import "@/lib/snapshot-watch-init";

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
  // R13: PWA — installable on tablets/phones (service worker in /sw.js)
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#714B67",
  width: "device-width",
  initialScale: 1,
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
