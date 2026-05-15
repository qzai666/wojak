#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const manifestPath = path.resolve(__dirname, "../wojak-draft-extension/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const versionMatch = String(manifest.version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);

if (!versionMatch) {
  throw new Error(`Unsupported extension version: ${manifest.version || "<empty>"}`);
}

const nextVersion = [
  versionMatch[1],
  versionMatch[2],
  String(Number(versionMatch[3]) + 1)
].join(".");

manifest.version = nextVersion;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${nextVersion}\n`);
