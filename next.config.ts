import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow Arena/E2B preview origins for dev HMR
  // The preview is served from https://{port}-{sandboxId}.e2b.app which is cross-origin
  // Without this, Next.js 16 blocks /_next/webpack-hmr with "Blocked cross-origin request"
  allowedDevOrigins: [
    "*.e2b.app",
    "*.e2b.dev",
    "https://*.e2b.app",
    "https://*.e2b.dev",
    // Explicitly allow the current sandbox pattern - will match any subdomain
    "3000-*.e2b.app",
  ],
};

export default nextConfig;
