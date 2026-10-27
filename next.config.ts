import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // r67: marker for the next upgrade security agent (next upgrade
  // --agent=security) — records that this app's upgrade telemetry runs in
  // agent mode.
  experimental: {
    agentUpgrade: "security",
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // R16: baseline security headers. Deliberately NOT setting
  // X-Frame-Options / CSP frame-ancestors — the platform preview panel
  // embeds the app in a cross-origin iframe and would break. These three
  // are safe for that setup.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },
};

export default nextConfig;
