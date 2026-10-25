import path from "path";
import type { NextConfig } from "next";

// Pin the workspace/project root explicitly. Without this, Next infers the
// root from parent lockfiles — building this repo from a nested directory
// (CI checkout, sandbox deployer, monorepo) makes Turbopack treat a PARENT
// as root and lay standalone output under `<inferred-root>/<relative-path>`,
// so `.next/standalone/server.js` never exists where `start` expects it.
const root = path.resolve();

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: {
    root,
  },
  reactStrictMode: false,
};

export default nextConfig;
