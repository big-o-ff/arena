import "./globals.css";
import type { ReactNode } from "react";
import { JetBrains_Mono, Share_Tech_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import ClientShell from "./ClientShell";
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

/*
 * Both faces were previously declared through `metadata.other`, which emits
 * <meta name="rel"> / <meta name="url"> — inert. Neither font ever loaded, so
 * the app fell back to the platform's default monospace everywhere despite
 * globals.css and the Tailwind theme both naming these families. `next/font`
 * self-hosts them, so there is no render-blocking third-party request either.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const shareTechMono = Share_Tech_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-share-tech-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Big O'ff",
  description: "gamified dsa platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      dynamic
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "#00FF00",
          colorBackground: "#0d0d0d",
          colorText: "#eaeaea",
          colorTextSecondary: "#888888",
          colorInputBackground: "#1a1a1a",
          colorInputText: "#eaeaea",
          fontFamily: "JetBrains Mono, monospace",
        },
        elements: {
          headerSubtitle: "hidden",
          footerActionLink: "text-noir-terminal hover:text-noir-accent font-bold",
          card: "border border-noir-terminal shadow-[0_0_15px_rgba(0,255,0,0.1)]",
          headerTitle: "text-noir-terminal uppercase tracking-widest text-xl",
          socialButtonsBlockButton: "border border-white/20 bg-white/5 hover:bg-white/10 text-white",
          socialButtonsBlockButtonText: "text-white font-medium",
          dividerLine: "bg-white/10",
          dividerText: "text-white/40",
        },
      }}
    >
      <html
        lang="en"
        className={`${jetbrainsMono.variable} ${shareTechMono.variable}`}
      >
        <body className="relative min-h-screen bg-noir-bg font-mono text-noir-terminal">
          <ClientShell>{children}</ClientShell>
        </body>
      </html>
    </ClerkProvider>
  );
}