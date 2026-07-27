import next from "eslint-config-next";

/**
 * Flat config. Next 16 removed `next lint`, so linting runs through the eslint
 * CLI directly and eslint-config-next is version-matched to next itself — it
 * was pinned at 14.1.0 against next 16, which is why nothing linted.
 */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "*.tsbuildinfo",
    ],
  },
  ...next,
  {
    rules: {
      // Downgraded from error to warning. The rule fires on the ordinary
      // "set a loading flag, then fetch" effect, which is most of the data
      // loading in this app. Left visible rather than switched off — the
      // genuine cascading-render cases (state reset on prop change) have been
      // fixed; what remains are fetch kick-offs.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
