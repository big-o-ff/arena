"use client";

import { useRouter } from "next/navigation";
import { SignInButton, useAuth } from "@clerk/nextjs";
import logo from "../assets/logo.jpg";
import Link from "next/link";

export default function LandingPage() {
  const router = useRouter();
  const { isLoaded, userId } = useAuth();

  return (
    <>
      {/* UI Corner Decorations */}
      <div className="corner-decor top-left">
        [ SYSTEM: ONLINE ]
        <br />
        [ AUTH: PENDING ]
      </div>
      <div className="corner-decor top-right">
        [ v2.4.7 ]
        <br />
        [ SECURE ]
      </div>
      <div className="corner-decor bottom-left">[ 127.0.0.1 ]</div>
      <div className="corner-decor bottom-right">
        [ ENCRYPTED ]
        <br />
        [ AES-256 ]
      </div>

      <div className="landing-container">
        {/* 3D Logo Cube */}
        <div className="logo-container">
          <div className="logo-3d">
            <div className="logo-face front">
              <img src={logo.src} alt="Bigoff logo" />
            </div>
            <div className="logo-face back">
              <img src={logo.src} alt="Bigoff logo" />
            </div>
            <div className="logo-face left">
              <img src={logo.src} alt="Bigoff logo" />
            </div>
            <div className="logo-face right">
              <img src={logo.src} alt="Bigoff logo" />
            </div>
            <div className="logo-face top" />
            <div className="logo-face bottom" />
          </div>
        </div>

        {/* Action Controls */}
        <div className="button-container flex flex-col items-center">
          {isLoaded ? (
            !userId ? (
              /* --- STATE: UNAUTHENTICATED --- */
              <div className="w-full flex flex-col items-center">
                <SignInButton mode="modal" forceRedirectUrl="/lobby">
                  <button type="button" className="cyber-button btn-initiate hidden md:block">
                    <span className="button-text">Initiate Battle</span>
                  </button>
                </SignInButton>

                {/* Mobile Ghost Version */}
                <button
                  type="button"
                  className="cyber-button opacity-50 cursor-not-allowed md:hidden w-full"
                  disabled
                >
                  <span className="button-text text-xs">
                    [ DESKTOP ONLY TO BATTLE ]
                  </span>
                </button>
              </div>
            ) : (
              /* --- STATE: AUTHENTICATED --- */
              <div className="w-full flex flex-col items-center">
                <button
                  type="button"
                  className="cyber-button btn-initiate hidden md:block"
                  onClick={() => router.push("/lobby")}
                >
                  <span className="button-text">Enter Arena</span>
                </button>

                {/* Mobile Ghost Version */}
                <button
                  type="button"
                  className="cyber-button opacity-50 cursor-not-allowed md:hidden w-full"
                  disabled
                >
                  <span className="button-text text-xs">
                    [ BATTLE ON DESKTOP ]
                  </span>
                </button>
              </div>
            )
          ) : (
            /* --- STATE: LOADING (prevents layout shift) --- */
            <div className="h-12 w-full" />
          )}

          {/* SHARED ACTION: spectate (active for all) */}
          <Link href="/spectate" className="w-full md:w-auto mt-4">
            <button type="button" className="cyber-button btn-spectate w-full">
              <span className="button-text">Spectate Arena</span>
            </button>
          </Link>
        </div>
      </div>
    </>
  );
}