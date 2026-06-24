#!/usr/bin/env node
/**
 * build-zip.mjs — compile this Omadia plugin and produce an uploadable ZIP.
 *
 * Adapted from the omadia-plugin-starter skeleton.
 *
 *     npm run build        # → out/<id>-<version>.zip
 *
 * Why esbuild and not plain `tsc`?
 *   The Omadia host resolves a plugin's bare imports against ITS OWN
 *   node_modules. Anything the host does NOT already ship (here: nodemailer)
 *   must therefore be BUNDLED into dist/plugin.js. We esbuild-bundle
 *   `src/plugin.ts` → `dist/plugin.js` (ESM), keeping only the host-provided
 *   peers external (see `external` below).
 *
 * Steps:
 *   1) esbuild bundle  → dist/plugin.js
 *   2) verify the entry exists
 *   3) stage runtime artefacts into out/<id>-<version>-package/
 *   4) zip into out/<id>-<version>.zip
 *
 * Run `npm run typecheck` separately for the tsc gate.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const pkgRoot = process.cwd();

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- 1) esbuild bundle -----------------------------------------------------
// ESM banner so any bundled CJS dependency (nodemailer) can still call require
// / __dirname / __filename inside the ESM output.
const ESM_BANNER = [
  "import { createRequire as ___createRequire } from 'node:module';",
  "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
  "import { dirname as ___dirname } from 'node:path';",
  'const require = ___createRequire(import.meta.url);',
  'const __filename = ___fileURLToPath(import.meta.url);',
  'const __dirname = ___dirname(__filename);',
].join('\n');

console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(pkgRoot, 'dist/plugin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: ESM_BANNER },
  external: [
    // Host-provided peers — NEVER bundle these; the Omadia host supplies them.
    '@omadia/plugin-api',
    '@omadia/channel-sdk',
    'express',
  ],
});

// --- 2) verify entry -------------------------------------------------------
const entryRel = pkg.main ?? 'dist/plugin.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after bundle: ${entryRel}`);
}

// --- 3) stage runtime artefacts -------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// The omadia upload validator allow-lists by file EXTENSION. Some core
// versions accept a bare `LICENSE`/`NOTICE`, others reject any extensionless
// file ("disallowed extension (<none>)"). Stage those two with a `.txt`
// extension so the ZIP is accepted everywhere; everything else already carries
// an allow-listed extension.
const INCLUDE = ['manifest.yaml', 'package.json', 'dist', 'assets', 'skills', 'README.md'];
const RENAME = { LICENSE: 'LICENSE.txt', NOTICE: 'NOTICE.txt' };
for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}
for (const [src, dest] of Object.entries(RENAME)) {
  const srcAbs = join(pkgRoot, src);
  if (!existsSync(srcAbs)) continue;
  cpSync(srcAbs, join(stageDir, dest));
}

// --- 4) zip ----------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — on Windows use `7z a` or PowerShell `Compress-Archive`');
}

console.log(`✓ built ${zipPath}`);
