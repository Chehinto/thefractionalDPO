/**
 * `next lint` was removed in Next 16, so `npm run lint` now calls ESLint
 * directly against this flat config. The two `eslint-config-next` entry points
 * below are what `next lint` used to assemble on our behalf.
 */
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "public/build-info.json",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];
