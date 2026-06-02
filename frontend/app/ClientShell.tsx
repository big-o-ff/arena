"use client";

import type { ReactNode } from "react";
import { MatrixBackground } from "../components/MatrixBackground";
import {
  useAuth,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";

export default function ClientShell({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();

  return (
    <div className="flex min-h-screen flex-col">
      <MatrixBackground />
      <div className="scanline-overlay" />

      <header className="relative z-20 flex shrink-0 items-center justify-end gap-3 px-4 py-2 min-h-[3rem]">
        {isLoaded && !userId && (
          <SignInButton mode="modal">
            <button type="button" className="cyber-btn border-noir-terminal text-noir-terminal hover:bg-noir-terminal/10 text-xs px-4 py-2 uppercase tracking-widest">
              Login / Access System
            </button>
          </SignInButton>
        )}
        {isLoaded && userId && (
          <UserButton
            appearance={{
              elements: {
                avatarBox: "w-8 h-8 border border-noir-accent",
              },
            }}
          />
        )}
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
