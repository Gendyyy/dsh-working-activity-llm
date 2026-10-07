/**
 * Vitest configuration for the plugin's own test tree.
 *
 * The only non-default setting is the JSX transform. The browser half is
 * written against the automatic runtime (`jsx: "react-jsx"` in
 * `tsconfig.client.json`, and `react/jsx-runtime` is a platform seed word in
 * the shell's module table), but Vitest's default esbuild transform compiles
 * JSX to `React.createElement`, which the component never imports — so any test
 * that invokes a `.tsx` component as a plain function would fail with
 * `React is not defined`. Pinning the transform here keeps the test tree
 * compiling the same way the shipped bundle does.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.spec.ts'],
    // No environment: the components are hook-free and are driven through their
    // ref callbacks with fake nodes, so neither jsdom nor a renderer is needed.
  },
})
