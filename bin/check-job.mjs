#!/usr/bin/env node
/**
 * check-job.mjs — is a posting still live? Thin JSON wrapper around
 * career-ops's own check-liveness.mjs (ATS-API-based; --no-fallback skips
 * the slow headed-browser fallback so a bar-widget button stays responsive).
 *
 * Usage:
 *   node check-job.mjs --career-ops <dir> --url "https://..."
 *
 * Prints one JSON line: {"ok":true,"status":"active"|"expired"|"uncertain","reason":"..."}
 *                    or  {"ok":false,"error":"..."}
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
      out[key] = val;
    }
  }
  return out;
}

function parseOutput(text) {
  // e.g. "✅ active     (api) https://..." / "❌ expired    (api) https://..."
  // / "⚠️ uncertain        https://..." followed by an indented reason line.
  const statusMatch = /\b(active|expired|uncertain)\b/.exec(text);
  const lines = text.split("\n");
  let reason = "";
  for (let i = 0; i < lines.length; i++) {
    if (statusMatch && lines[i].includes(statusMatch[1])) {
      const next = (lines[i + 1] || "").trim();
      if (next && !/^Results:/.test(next)) reason = next;
      break;
    }
  }
  return { status: statusMatch ? statusMatch[1] : "unknown", reason };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const careerOpsDir = args["career-ops"];
  const url = args.url;

  if (!careerOpsDir || !existsSync(careerOpsDir)) {
    console.log(JSON.stringify({ ok: false, error: `career-ops dir not found: ${careerOpsDir}` }));
    process.exit(1);
  }
  if (!url) {
    console.log(JSON.stringify({ ok: false, error: "missing --url" }));
    process.exit(1);
  }

  const scriptPath = join(careerOpsDir, "check-liveness.mjs");
  let output = "";
  try {
    output = execFileSync("node", [scriptPath, "--no-fallback", url], {
      cwd: careerOpsDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch (err) {
    // check-liveness.mjs exits non-zero whenever a URL isn't "active" —
    // that's not a script failure, the output is still on stdout.
    output = String(err.stdout || "");
    if (!output) {
      console.log(JSON.stringify({ ok: false, error: String(err.message || err) }));
      process.exit(1);
    }
  }

  const { status, reason } = parseOutput(output);
  console.log(JSON.stringify({ ok: true, status, reason }));
}

main();
