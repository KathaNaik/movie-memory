import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't auto-generate AGENTS.md when `next dev` is started by a coding agent.
  agentRules: false,
  images: {
    // Google profile photos are served from lh3…lh6 (and other) subdomains.
    remotePatterns: [{ protocol: "https", hostname: "*.googleusercontent.com" }],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
