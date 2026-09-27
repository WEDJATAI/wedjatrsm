import type { Metadata, Viewport } from "next";
// R30/P5: fonts are SELF-HOSTED (public/fonts + fonts.css) — deterministic
// offline builds; next/font/google's build-time Google Fonts fetch broke the
// Windows CI runner (run 36346239172). Same files, same subsets, same vars.
import "./fonts.css";
import "./globals.css";
// R21: in-app auto-snapshot watcher (side-effect import — do not remove)
import "@/lib/snapshot-watch-init";

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
        className={`antialiased bg-background text-foreground font-[family-name:var(--font-geist-sans)] rtl:font-[family-name:var(--font-cairo)]`}
      >
        {children}
      </body>
    </html>
  );
}
