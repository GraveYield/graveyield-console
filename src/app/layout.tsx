import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SolanaProviders } from "@/components/gy/providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "GraveYield — Salvage Console",
  description:
    "Salvage console on Solana devnet: derelict pool explorer, salvor fleet, LP claims, and protocol reference.",
  openGraph: {
    title: "GraveYield — Salvage Console",
    description: "Salvage console on Solana devnet.",
    siteName: "GraveYield",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#161616",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${inter.variable} font-sans antialiased bg-background text-foreground`}
      >
        <SolanaProviders>
          {children}
        </SolanaProviders>
        <Toaster />
      </body>
    </html>
  );
}
