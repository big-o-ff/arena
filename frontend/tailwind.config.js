/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        noir: {
          bg: "#050608",
          surface: "#0b0f16",
          border: "#1f2933",
          terminal: "#39FF14",
          accent: "#00F0FF",
          danger: "#ff0050"
        }
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"]
      }
    }
  },
  plugins: []
};

