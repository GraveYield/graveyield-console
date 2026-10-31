import path from "path";
import type { NextConfig } from "next";

// Pin the workspace/project root explicitly. Without this, Next infers the
// root from parent lockfiles — building this repo from a nested directory
// (CI checkout, sandbox deployer, monorepo) makes Turbopack treat a PARENT
// as root and lay standalone output under `<inferred-root>/<relative-path>`,
// so `.next/standalone/server.js` never exists where `start` expects it.
const root = path.resolve();

// ── Security headers (review 2026-10-31, F3) ────────────────────────────
// A wallet-connected console must not be frameable (clickjacking), must
// not sniff-render attacker-served bytes, and must leak as little referrer
// data as possible. The CSP is deliberately practical:
//   · script-src 'unsafe-inline' is required by the Next.js runtime
//     (bootstrap/hydration inline scripts — no nonce without middleware);
//     external script injection is still blocked.
//   · connect-src allows https: because the RPC endpoint is env-overridable
//     (NEXT_PUBLIC_SOLANA_RPC_URL — private/quota-ed devnet endpoints are a
//     documented deployment shape); a fixed host allowlist would break
//     legitimate deploys. ws:/wss: keeps local dev HMR working.
//   · img-src data: covers the wallet adapters' extension-provided icons.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self' https: ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  // Backward-compatible framing refusal alongside frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: {
    root,
  },
  reactStrictMode: false,
  // The runtime banner is fingerprint noise; drop it.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Every route — pages and API envelopes alike.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
