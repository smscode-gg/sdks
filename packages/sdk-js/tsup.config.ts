import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: false, // public SDK: don't ship source maps — they embed the full TS source via `sourcesContent`; the source lives in the public repo

  clean: true,
  treeshake: true,
  minify: false,
  target: "es2022",
});
