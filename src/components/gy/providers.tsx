"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

/**
 * Real Solana wallet stack on devnet.
 *
 * No explicit adapter list: wallets implementing the Wallet Standard
 * (Phantom, Solflare, Backpack, …) are auto-detected at runtime, and the
 * previously-selected wallet is reconnected eagerly via the provider's
 * localStorage-backed selection. RPC endpoint is env-overridable for
 * private/quota-ed devnet endpoints.
 */
export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("devnet"),
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
