#!/usr/bin/env node
/**
 * why-fit.mjs — "why is this job tailored for me?", sourced entirely from
 * the candidate's own authored config/profile.yml (target_roles.archetypes
 * + narrative.proof_points). No LLM call, nothing invented: this picks the
 * archetype whose `sell_when` best overlaps the job's title/company, then
 * returns that archetype's own sell_when line plus its real proof points.
 *
 * Usage:
 *   node why-fit.mjs --career-ops <dir> --company "Acme" --role "AI Engineer"
 *
 * Prints one JSON line:
 *   {"ok":true,"archetype":"AI/ML Engineer","why":"...","proofPoints":["...", "..."]}
 *   {"ok":false,"error":"..."}
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

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

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "jd",
  "emphasizes", "says", "is", "at", "junior", "mid", "senior", "level",
]);

function keywords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9/+\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function scoreArchetype(archetype, job) {
  // Word-set membership, not substring — `.includes()` would match "end"
  // (from "end-to-end") inside "backend", misclassifying Backend Engineer
  // roles as Product Engineer.
  const haystackWords = new Set(keywords(`${job.role} ${job.company}`));
  // sell_when carries the specific phrasing; the archetype name carries
  // distinguishing terms too (e.g. "Forward Deployed" only appears in that
  // archetype's *name*, not its sell_when) — both matter, now that matching
  // is word-boundary safe instead of substring.
  const words = keywords(archetype.sell_when).concat(keywords(archetype.name));
  let score = 0;
  for (const w of words) if (haystackWords.has(w)) score += 1;
  return score;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const careerOpsDir = args["career-ops"];
  const company = args.company || "";
  const role = args.role || "";

  if (!careerOpsDir || !existsSync(careerOpsDir)) {
    console.log(JSON.stringify({ ok: false, error: `career-ops dir not found: ${careerOpsDir}` }));
    process.exit(1);
  }

  const profilePath = join(careerOpsDir, "config", "profile.yml");
  if (!existsSync(profilePath)) {
    console.log(JSON.stringify({ ok: false, error: `config/profile.yml not found at ${profilePath}` }));
    process.exit(1);
  }

  try {
    const require = createRequire(join(careerOpsDir, "package.json"));
    const yaml = require("js-yaml");
    const profile = yaml.load(readFileSync(profilePath, "utf-8"));

    const archetypes = (profile.target_roles && profile.target_roles.archetypes) || [];
    if (archetypes.length === 0) {
      console.log(JSON.stringify({ ok: false, error: "no archetypes in config/profile.yml" }));
      process.exit(1);
    }

    let best = archetypes[0];
    let bestScore = -1;
    for (const a of archetypes) {
      const s = scoreArchetype(a, { company, role });
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    // No keyword overlap at all — fall back to the candidate's own declared
    // primary archetype rather than a low-confidence guess.
    if (bestScore <= 0) {
      best = archetypes.find((a) => a.fit === "primary") || archetypes[0];
    }

    const proofPoints = ((profile.narrative && profile.narrative.proof_points) || [])
      .slice(0, 2)
      .map((p) => `${p.name} — ${p.hero_metric}`);

    const why = `Fits the ${best.name} track: ${best.sell_when}`;

    console.log(JSON.stringify({ ok: true, archetype: best.name, why, proofPoints }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err.message || err) }));
    process.exit(1);
  }
}

main();
