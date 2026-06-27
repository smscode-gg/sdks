#!/usr/bin/env bun
/**
 * Stale-types guard for `@smscode/sdk`.
 *
 * `packages/sdk-js/src/types.gen.ts` is GENERATED from the OpenAPI contract
 * (`docs/openapi/openapi.yaml`) by `openapi-typescript`, and committed to the
 * repo so SDK consumers and the build don't need to regenerate it. The risk:
 * someone edits `openapi.yaml` (or hand-edits the generated file) and forgets
 * to regenerate / commit, so the committed types drift from the contract.
 *
 * This script regenerates the types to a temp file and diffs against the
 * committed file. Exit 0 if identical (fresh), exit 1 if different (stale) —
 * with instructions to run `bun run gen:types` and commit.
 *
 * Run from anywhere:  bun run scripts/check-openapi-types-fresh.ts
 * Or via the package: cd packages/sdk-js && bun run check:types
 *
 * No third-party deps — uses Bun's built-in spawn + Node fs/path/os.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OPENAPI_SPEC = join(REPO_ROOT, "docs", "openapi", "openapi.yaml");
const SDK_DIR = join(REPO_ROOT, "packages", "sdk-js");
const COMMITTED_TYPES = join(SDK_DIR, "src", "types.gen.ts");
const GEN_BIN = join(SDK_DIR, "node_modules", ".bin", "openapi-typescript");

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// 1. Read the committed (source-of-truth) generated file.
let committed: string;
try {
  committed = readFileSync(COMMITTED_TYPES, "utf8");
} catch {
  fail(
    `Committed types not found at ${COMMITTED_TYPES}.\n` +
      `  Run: cd packages/sdk-js && bun run gen:types`,
  );
}

// 2. Regenerate into a throwaway temp file (never touches the committed one).
const tmp = mkdtempSync(join(tmpdir(), "smscode-types-"));
const tmpOut = join(tmp, "types.gen.ts");
try {
  const result = spawnSync(GEN_BIN, [OPENAPI_SPEC, "-o", tmpOut], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    fail(
      `Failed to run openapi-typescript (${GEN_BIN}): ${result.error.message}\n` +
        `  Did you run \`bun install\` in packages/sdk-js?`,
    );
  }
  if (result.status !== 0) {
    fail(
      `openapi-typescript exited with code ${result.status}.\n` +
        `${result.stderr ?? ""}`,
    );
  }

  // 3. Compare.
  const fresh = readFileSync(tmpOut, "utf8");
  if (fresh === committed) {
    console.log(
      "✓ packages/sdk-js/src/types.gen.ts is in sync with docs/openapi/openapi.yaml",
    );
    process.exit(0);
  }

  fail(
    `packages/sdk-js/src/types.gen.ts is STALE — it does not match the types\n` +
      `  generated from docs/openapi/openapi.yaml.\n\n` +
      `  Regenerate and commit:\n` +
      `    cd packages/sdk-js && bun run gen:types\n` +
      `    git add packages/sdk-js/src/types.gen.ts\n\n` +
      `  (Do NOT hand-edit types.gen.ts — it is generated from the contract.)`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
