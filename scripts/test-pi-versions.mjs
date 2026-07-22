#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PI_VERSIONS = ["0.76.0", "0.78.0", "0.80.7", "0.80.10", "0.81.1"];
const TEST_DEPS = [
  "typebox@1.1.39",
  "marked@18.0.4",
  "typescript@6.0.3",
  "vitest@4.1.8",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const keepTemp = process.env.PI_TELEGRAM_PLUS_KEEP_MATRIX_TMP === "1";

function parseVersions() {
  const fromArgs = process.argv.slice(2).filter(Boolean);
  if (fromArgs.length > 0) return fromArgs;
  const fromEnv = process.env.PI_TELEGRAM_PLUS_PI_VERSIONS?.split(/[\s,]+/).filter(Boolean) ?? [];
  return fromEnv.length > 0 ? fromEnv : DEFAULT_PI_VERSIONS;
}

function run(command, args, cwd, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectRun(new Error(`${label} failed with ${suffix}`));
    });
  });
}

function shouldCopy(src) {
  const rel = relative(repoRoot, src);
  if (!rel) return true;
  const first = rel.split(sep)[0];
  if ([".git", "node_modules", ".pi", ".pi-subagents", "dist", "coverage"].includes(first)) return false;
  if (basename(src) === "package-lock.json") return false;
  return true;
}

async function copyWorkspace(dest) {
  await cp(repoRoot, dest, {
    recursive: true,
    filter: shouldCopy,
  });
}

async function testVersion(version) {
  const tempRoot = await mkdtemp(join(tmpdir(), `pi-tg-plus-${version.replace(/[^a-zA-Z0-9._-]/g, "_")}-`));
  const workDir = join(tempRoot, "repo");
  console.log(`\n=== pi ${version} ===`);
  console.log(`temp: ${workDir}`);
  try {
    await copyWorkspace(workDir);
    const packageLock = join(workDir, "package-lock.json");
    if (existsSync(packageLock)) await rm(packageLock, { force: true });
    await run("npm", [
      "install",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      `@earendil-works/pi-coding-agent@${version}`,
      ...TEST_DEPS,
    ], workDir, `install pi ${version}`);
    await run("npm", ["run", "typecheck"], workDir, `typecheck pi ${version}`);
    await run("npm", ["test"], workDir, `test pi ${version}`);
    console.log(`✓ pi ${version} passed`);
    return { version, ok: true };
  } catch (error) {
    console.error(`✗ pi ${version} failed: ${error instanceof Error ? error.message : String(error)}`);
    return { version, ok: false, error };
  } finally {
    if (keepTemp) console.log(`kept temp: ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

const versions = parseVersions();
console.log(`Testing pi versions: ${versions.join(", ")}`);
const results = [];
for (const version of versions) {
  results.push(await testVersion(version));
}
const failed = results.filter((result) => !result.ok);
console.log("\n=== matrix summary ===");
for (const result of results) {
  console.log(`${result.ok ? "✓" : "✗"} ${result.version}`);
}
if (failed.length > 0) {
  console.error(`\n${failed.length} pi version(s) failed. See the first failing command above for the exact step.`);
  process.exitCode = 1;
}
