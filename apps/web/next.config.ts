import type { NextConfig } from "next";

const serverPort = process.env.INTERVIEW_OS_PORT ?? "4100";

const nextConfig: NextConfig = {
  transpilePackages: ["@interview-os/core"],
  webpack(config) {
    // workspace packages use .js ESM specifiers that point at .ts sources
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
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
