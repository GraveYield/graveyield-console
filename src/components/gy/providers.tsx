"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { configuredRpcEndpoint } from "@/lib/gy/protocolLive";

/**
 * Real Solana wallet stack on devnet.
 *
 * No explicit adapter list: wallets implementing the Wallet Standard
 * (Phantom, Solflare, Backpack, …) are auto-detected at runtime, and the
 * previously-selected wallet is reconnected eagerly via the provider's
 * localStorage-backed selection.
 *
 * Audit finding 5.4: the endpoint comes from the console's SINGLE documented
 * RPC configuration source (protocolLive.configuredRpcEndpoint) — the same
 * `NEXT_PUBLIC_SOLANA_RPC_URL` the protocol pulse, epoch telemetry and
 * cluster verification use, with the same public-devnet fallback. Wallet
 * reads can no longer point at a different endpoint than every other read.
 */
export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => configuredRpcEndpoint(), []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
