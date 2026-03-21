"use client";

import { useRouter } from "next/navigation";
import { SignInButton, SignedIn, SignedOut } from "@clerk/nextjs";
import logo from "../assets/logo.jpg";
import Link from "next/link"; // Added for Spectate

export default function LandingPage() {
  const router = useRouter();

  return (
    <>
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

      <div className="container">
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

        <div className="tagline">the first real-time DSA battleground</div>

        <div className="button-container">
          <SignedOut>
            {/* INITIATE: Standard flow leads with Sign In */}
            <SignInButton mode="modal" forceRedirectUrl="/lobby">
              <button className="cyber-button btn-initiate">
                <span className="button-text">Initiate Battle</span>
              </button>
            </SignInButton>
          </SignedOut>

          <SignedIn>
            <button
              className="cyber-button btn-initiate"
              onClick={() => router.push("/lobby")}
            >
              <span className="button-text">Enter Arena</span>
            </button>
          </SignedIn>

          {/* SPECTATE: Direct jump, no login required (Standard) */}
          <Link href="/spectate" className="w-full md:w-auto mt-4 block">
            <button className="cyber-button btn-spectate">
              <span className="button-text">Spectate Arena</span>
            </button>
          </Link>
        </div>
      </div>
    </>
  );
}