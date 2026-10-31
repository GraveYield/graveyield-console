// Security headers battery (security review 2026-10-31, F3).
//
// The console is a wallet-connected surface: it must refuse framing
// (clickjacking), refuse MIME sniffing, minimize referrer leakage, and
// carry a CSP that blocks object/base-uri/frame attacks. These headers are
// part of the shipped security posture — this battery keeps them from
// silently disappearing from next.config.ts.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import nextConfig from "../../../../next.config";

type HeaderRow = { key: string; value: string };
type HeaderTable = { source: string; headers: HeaderRow[] };

async function headerTables(): Promise<HeaderTable[]> {
  const h = nextConfig.headers;
  if (typeof h !== "function") throw new Error("next.config headers() is missing");
  const fn = h as unknown as () => Promise<HeaderTable[]>;
  return await fn();
}

const tablesPromise = headerTables();

describe("security headers (next.config.ts)", () => {
  test("headers() applies one table to every route", async () => {
    const tables = await tablesPromise;
    expect(tables.length).toBe(1);
    expect(tables[0]!.source).toBe("/:path*");
    expect(tables[0]!.headers.length).toBeGreaterThanOrEqual(5);
  });

  test("CSP: framing, object embeds and base-uri hijack are closed", async () => {
    const tables = await tablesPromise;
    const csp = tables[0]!.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // Practical Next.js runtime allowance (inline bootstrap scripts).
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  test("X-Frame-Options DENY + nosniff + referrer + permissions are present", async () => {
    const tables = await tablesPromise;
    const h = (k: string) => tables[0]!.headers.find((x) => x.key === k)?.value;
    expect(h("X-Frame-Options")).toBe("DENY");
    expect(h("X-Content-Type-Options")).toBe("nosniff");
    expect(h("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h("Permissions-Policy")).toContain("camera=()");
    expect(h("Permissions-Policy")).toContain("microphone=()");
    expect(h("Permissions-Policy")).toContain("payment=()");
  });

  test("the runtime banner is off (poweredByHeader)", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
