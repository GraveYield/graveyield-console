import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SolanaProviders } from "@/components/gy/providers";

const manrope = Manrope({
  variable: "--font-manrope",
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
  themeColor: "#161618",
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
        className={`${manrope.variable} font-sans antialiased bg-background text-foreground`}
      >
        <SolanaProviders>
          {children}
        </SolanaProviders>
        <Toaster />
      </body>
    </html>
  );
}
