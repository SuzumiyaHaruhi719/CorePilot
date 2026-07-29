#!/usr/bin/env node
/**
 * Build, sign and publish a CorePilot release that the in-app updater can read.
 *
 * The updater's whole contract lives in one file — `latest.json`, fetched from
 * `releases/latest/download/latest.json` — and every way that file can be wrong
 * is silent from the user's side: the app just never finds an update, or finds
 * one it refuses to install. So this script front-loads the checks and refuses
 * to build on anything that would produce a broken manifest.
 *
 *   node scripts/release.mjs [--notes <file>] [--dry-run]
 *
 * Requires: `gh` authenticated, and the updater signing key via
 * TAURI_SIGNING_PRIVATE_KEY (or TAURI_SIGNING_PRIVATE_KEY_PATH).
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const RELEASE_DIR = join(SRC_TAURI, "target", "release");
const OUT_DIR = join(ROOT, "release");
const REPO = "SuzumiyaHaruhi719/CorePilot";

/** Files that make up a portable install, and where each comes from. */
const PORTABLE_PARTS = [
  { name: "corepilot.exe", from: join(RELEASE_DIR, "corepilot.exe") },
  { name: "sensord.exe", from: join(SRC_TAURI, "binaries", "sensord-x86_64-pc-windows-msvc.exe") },
  { name: "corepilot_overlay.dll", from: join(RELEASE_DIR, "corepilot_overlay.dll") },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesArg = args.indexOf("--notes") >= 0 ? args[args.indexOf("--notes") + 1] : null;

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
const capture = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", cwd: ROOT, ...opts }).trim();

// ---------------------------------------------------------------------------
// 1. Preflight — everything that can be wrong before a 10-minute build starts
// ---------------------------------------------------------------------------

step("Preflight");

// The three version fields must agree. `tauri.conf.json` decides the artifact
// FILE NAMES, `Cargo.toml` decides the version the RUNNING app compares against,
// and a disagreement means the app either re-offers an update it already
// installed (baked version lower than the manifest) or never sees one at all.
const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const confVersion = JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8")).version;
const cargoVersion = readFileSync(join(SRC_TAURI, "Cargo.toml"), "utf8")
  .split(/\r?\n/)
  .find((l, i, all) => all.slice(0, i).some((p) => p.trim() === "[package]") && l.startsWith("version = "))
  ?.match(/"([^"]+)"/)?.[1];

if (!(pkgVersion && confVersion && cargoVersion)) {
  die("could not read the version from all three of package.json / Cargo.toml / tauri.conf.json");
}
if (!(pkgVersion === confVersion && confVersion === cargoVersion)) {
  die(
    `version mismatch — package.json=${pkgVersion}, Cargo.toml=${cargoVersion}, tauri.conf.json=${confVersion}.\n` +
      `  Set all three to the same value before releasing.`,
  );
}
const VERSION = pkgVersion;
const TAG = `v${VERSION}`;
console.log(`  version ${VERSION} (all three files agree)`);

if (!(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
  die(
    "no updater signing key. The build would produce artifacts without .sig files and every client\n" +
      "  would reject the update.\n" +
      "  Set one of:\n" +
      "    TAURI_SIGNING_PRIVATE_KEY_PATH=$HOME/.tauri/corepilot.key\n" +
      "    TAURI_SIGNING_PRIVATE_KEY=<key contents>\n" +
      "  (plus TAURI_SIGNING_PRIVATE_KEY_PASSWORD if the key has one)",
  );
}

const dirty = capture("git status --porcelain");
if (dirty) die(`working tree is dirty — commit or stash first:\n${dirty}`);

const tags = capture("git tag").split(/\r?\n/);
if (tags.includes(TAG)) die(`tag ${TAG} already exists. Bump the version, or delete the tag to re-release.`);

try {
  capture("gh auth status", { stdio: "pipe" });
} catch {
  die("`gh` is not authenticated — run `gh auth login`.");
}

// Release notes become BOTH the GitHub release body and the `notes` the update
// prompt shows in-app, so they are worth getting from a real file.
const notesFile = notesArg ?? (existsSync(join(ROOT, "RELEASE_NOTES.md")) ? join(ROOT, "RELEASE_NOTES.md") : null);
let notes;
if (notesFile) {
  notes = readFileSync(notesFile, "utf8").trim();
  console.log(`  notes from ${notesFile} (${notes.length} chars)`);
} else {
  notes = `CorePilot ${VERSION}`;
  console.warn(
    `  ! no release notes — the in-app update prompt will show only "${notes}".\n` +
      `    Write RELEASE_NOTES.md or pass --notes <file>.`,
  );
}

if (dryRun) {
  console.log("\n--dry-run: preflight passed, stopping before the build.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Build
// ---------------------------------------------------------------------------

// Build order is mandatory: `tauri.conf.json` lists the overlay DLL as a bundle
// resource and `tauri-build` validates that path at compile time, so the app
// build fails outright until the DLL exists.
step("Building the overlay DLL");
run("cargo build -p corepilot-overlay --release", { cwd: SRC_TAURI });

step("Building the app (npx tauri build)");
run("npx tauri build");

const setupExe = join(RELEASE_DIR, "bundle", "nsis", `CorePilot_${VERSION}_x64-setup.exe`);
const setupSig = `${setupExe}.sig`;
if (!existsSync(setupExe)) die(`installer not found at ${setupExe}`);
if (!existsSync(setupSig)) {
  die(
    `installer signature not found at ${setupSig}.\n` +
      `  Check that bundle.createUpdaterArtifacts is true in tauri.conf.json and that the signing key was set.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Portable zip
// ---------------------------------------------------------------------------

step("Assembling the portable zip");
rmSync(OUT_DIR, { recursive: true, force: true });
const stage = join(OUT_DIR, "portable");
mkdirSync(stage, { recursive: true });

for (const part of PORTABLE_PARTS) {
  if (!existsSync(part.from)) die(`portable build is missing ${part.name} (expected at ${part.from})`);
  copyFileSync(part.from, join(stage, part.name));
}

const portableZip = join(OUT_DIR, `CorePilot_${VERSION}_portable_x64.zip`);
// Compress-Archive rather than an npm zip dependency — it ships with Windows and
// this script only ever runs there. `-Path <dir>/*` zips the CONTENTS, so the
// three files sit at the archive root where `updater.rs` expects them.
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${portableZip}' -Force`],
  { stdio: "inherit" },
);

step("Signing the portable zip");
// The installer's .sig came from the bundler; the portable zip is ours to sign.
// Same key, so the app's single embedded pubkey verifies both flavors.
run(`npx tauri signer sign "${portableZip}"`);
const portableSig = `${portableZip}.sig`;
if (!existsSync(portableSig)) die(`signing produced no ${portableSig}`);

// ---------------------------------------------------------------------------
// 4. latest.json
// ---------------------------------------------------------------------------

step("Writing latest.json");
const dl = (file) => `https://github.com/${REPO}/releases/download/${TAG}/${file}`;
const manifest = {
  version: VERSION,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    // Stock target — what an installed build asks for.
    "windows-x86_64": {
      signature: readFileSync(setupSig, "utf8").trim(),
      url: dl(`CorePilot_${VERSION}_x64-setup.exe`),
    },
    // Custom target — `updater.rs` requests this one when it detects a portable
    // install, so one manifest serves both flavors.
    "windows-x86_64-portable": {
      signature: readFileSync(portableSig, "utf8").trim(),
      url: dl(`CorePilot_${VERSION}_portable_x64.zip`),
    },
  },
};
const manifestPath = join(OUT_DIR, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------------------
// 5. Publish
// ---------------------------------------------------------------------------

step(`Publishing ${TAG}`);
const notesPath = join(OUT_DIR, "notes.md");
writeFileSync(notesPath, notes);

const assets = [setupExe, setupSig, portableZip, portableSig, manifestPath];
// `--latest` is not cosmetic: the app's endpoint is
// `releases/latest/download/latest.json`, which 404s for a draft or prerelease —
// and a 404 there means every client silently stops finding updates.
execFileSync(
  "gh",
  ["release", "create", TAG, ...assets, "--title", `CorePilot ${TAG}`, "--notes-file", notesPath, "--latest"],
  { stdio: "inherit", cwd: ROOT },
);

step("Verifying the published manifest is reachable");
const published = capture(
  `gh release view ${TAG} --json isDraft,isPrerelease,assets -q '.isDraft,.isPrerelease,([.assets[].name]|join(","))'`,
).split(/\r?\n/);
if (published[0] !== "false" || published[1] !== "false") {
  die(`release ${TAG} is a draft or prerelease — releases/latest/download/latest.json will 404 for every client.`);
}
if (!published[2]?.includes("latest.json")) die(`latest.json did not upload to ${TAG}`);

console.log(`\n✓ ${TAG} published with ${assets.length} assets.`);
console.log(`  Clients on ${VERSION}-or-older will offer this update on their next check.\n`);
