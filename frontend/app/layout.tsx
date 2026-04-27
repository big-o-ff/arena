import "./globals.css";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import ClientShell from "./ClientShell";
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: "Big O'ff",
  description: "gamified dsa platform",
  other: {
    rel: "stylesheet",
    url: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      dynamic
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "#00FF00",
          colorBackground: "#000000",
          fontFamily: "JetBrains Mono, monospace",
        },
        elements: {
          headerSubtitle: "hidden",
          footerActionLink: "text-noir-terminal hover:text-noir-accent font-bold",
          card: "border border-noir-terminal bg-black shadow-[0_0_15px_rgba(0,255,0,0.1)]",
          headerTitle: "text-noir-terminal uppercase tracking-widest text-xl",
        },
      }}
    >
      <html lang="en">
        <body className="relative min-h-screen bg-noir-bg font-mono text-noir-terminal">
          <ClientShell>{children}</ClientShell>
        </body>
      </html>
    </ClerkProvider>
  );
}