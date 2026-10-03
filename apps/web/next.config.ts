import type { NextConfig } from "next";

const serverPort = process.env.INTERVIEW_OS_PORT ?? "4100";

const nextConfig: NextConfig = {
  transpilePackages: ["@interview-os/core"],
  // gzip on proxied /api responses buffers SSE event streams into one chunk —
  // this is a local tool, compression buys nothing
  compress: false,
  webpack(config) {
    // workspace packages use .js ESM specifiers that point at .ts sources
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
  // §9.7: old routes moved under /prepare
  async redirects() {
    return [
      { source: "/prep", destination: "/prepare", permanent: false },
      { source: "/stories", destination: "/prepare/stories", permanent: false },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${serverPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
