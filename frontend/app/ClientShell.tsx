"use client";

import type { ReactNode } from "react";
import { MatrixBackground } from "../components/MatrixBackground";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";

export default function ClientShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <MatrixBackground />
      <div className="scanline-overlay" />

      <header className="relative z-20 flex shrink-0 items-center justify-end gap-3 px-4 py-2">
        <SignedOut>
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

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
