"use client";

import "./globals.css";
import type { ReactNode } from "react";
import { MatrixBackground } from "../components/MatrixBackground";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";
import { dark } from "@clerk/themes";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body className="relative min-h-screen bg-noir-bg text-noir-terminal font-mono">
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
          <MatrixBackground />
          <div className="scanline-overlay" />

          <header className="relative z-20 flex items-center justify-end gap-3 px-4 py-2">
            <SignedOut>
              {/* Force the modal to start on the Sign In page */}
              <SignInButton mode="modal">
                <button className="cyber-btn border-noir-terminal text-noir-terminal hover:bg-noir-terminal/10 text-xs px-4 py-2 uppercase tracking-widest">
                  Login / Access System
                </button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: "w-8 h-8 border border-noir-accent",
                  },
                }}
              />
            </SignedIn>
          </header>

          <main className="relative z-10 min-h-screen flex flex-col">
            {children}
          </main>
        </ClerkProvider>
      </body>
    </html>
  );
}