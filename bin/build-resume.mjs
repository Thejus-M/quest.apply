#!/usr/bin/env node
/**
 * build-resume.mjs — baseline tailored-per-company resume PDF.
 *
 * Reads <careerOps>/cv.md (the canonical CV), fills career-ops's
 * templates/cv-template.tex structure with it, retitles the header with the
 * target company/role, writes the .tex into <careerOps>/output/, and shells
 * out to career-ops's own generate-latex.mjs (tectonic/pdflatex) to compile.
 *
 * This is the *baseline* resume: same bullets for every job, just retitled,
 * so it works instantly with zero LLM calls and no API key. For a real
 * JD-tailored version, open career-ops in Claude Code and ask for `latex`
 * mode against the job URL.
 *
 * Usage:
 *   node build-resume.mjs --career-ops <dir> --company "Acme" --role "AI Engineer" [--url "https://..."]
 *
 * Prints one JSON line: {"ok":true,"pdf":"/abs/path.pdf","tex":"/abs/path.tex"}
 *                    or  {"ok":false,"error":"..."}
 */

import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { execFileSync } from "child_process";

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

function escapeLatex(s) {
  return String(s || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// cv.md bullets use "**term** — rest" markdown bold; convert to \textbf
// *after* escapeLatex has already run so the inserted backslash survives.
function mdBold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
}

function formatText(s) {
  return mdBold(escapeLatex(s));
}

function slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "company"
  );
}

function withScheme(u) {
  if (!u) return "";
  return /^https?:\/\//.test(u) ? u : `https://${u}`;
}

function field(text, label) {
  const m = new RegExp(`^-\\s*${label}:\\s*(.+)$`, "mi").exec(text);
  return m ? m[1].trim() : "";
}

// No `m` flag here: with `m`, `$` matches before every line's newline, not
// just end-of-string, so `[\s\S]*?(?=...|$)` (lazy, spanning lines) would
// stop after the section's first line instead of running to its actual end.
function section(text, name) {
  const m = new RegExp(`(?:^|\\n)##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(text);
  return m ? m[1].replace(/\n---\s*$/, "").trim() : "";
}

function extractBullets(block) {
  const lines = block.split("\n");
  const bullets = [];
  let current = null;
  for (const line of lines) {
    const m = /^-\s+(.+)$/.exec(line);
    if (m) {
      if (current !== null) bullets.push(current.trim());
      current = m[1];
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += " " + line.trim();
    }
  }
  if (current !== null) bullets.push(current.trim());
  return bullets;
}

function parseCvMd(text) {
  const cv = {
    name: "",
    email: "",
    github: "",
    linkedin: "",
    summary: "",
    experience: [],
    projects: [],
    skills: [],
    education: [],
  };

  const nameMatch = /^#\s+(.+)$/m.exec(text);
  if (nameMatch) cv.name = nameMatch[1].trim();

  cv.email = field(text, "Email");
  cv.github = field(text, "GitHub");
  cv.linkedin = field(text, "LinkedIn");
  cv.summary = section(text, "Summary");

  const expBlock = section(text, "Experience");
  if (expBlock) {
    for (const raw of expBlock.split(/\n(?=###\s)/)) {
      const block = raw.trim();
      if (!block) continue;
      const head = /^###\s+(.+?)\s+—\s+(.+)$/m.exec(block);
      const dates = /^\*\*(.+?)\*\*/m.exec(block);
      if (!head) continue;
      cv.experience.push({
        role: head[1].trim(),
        company: head[2].trim(),
        dates: dates ? dates[1].trim() : "",
        bullets: extractBullets(block),
      });
    }
  }

  const projBlock = section(text, "Projects");
  if (projBlock) {
    for (const line of projBlock.split("\n")) {
      const pm = /^-\s+\*\*(.+?)\*\*\s+—\s+(.+)$/.exec(line);
      if (!pm) continue;
      const rest = pm[2];
      const stackMatch = /Stack:\s*(.+?)\.?$/.exec(rest);
      const desc = stackMatch ? rest.slice(0, stackMatch.index).trim() : rest.trim();
      cv.projects.push({
        name: pm[1].trim(),
        description: desc,
        stack: stackMatch ? stackMatch[1].trim() : "",
      });
    }
  }

  const skillsBlock = section(text, "Technical Skills");
  if (skillsBlock) {
    for (const line of skillsBlock.split("\n")) {
      const sm = /^\*\*(.+?):\*\*\s*(.+)$/.exec(line.trim());
      if (!sm) continue;
      cv.skills.push({ category: sm[1].trim(), items: sm[2].trim() });
    }
  }

  const eduBlock = section(text, "Education");
  if (eduBlock) {
    const lines = eduBlock.split("\n").filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i += 2) {
      const deg = /^\*\*(.+?)\*\*/.exec(lines[i]);
      const school = (lines[i + 1] || "").trim();
      const schoolMatch = /^(.+?)\s*\|\s*(.+)$/.exec(school);
      if (!deg) continue;
      cv.education.push({
        degree: deg[1].trim(),
        school: schoolMatch ? schoolMatch[1].trim() : school,
        dates: schoolMatch ? schoolMatch[2].trim() : "",
      });
    }
  }

  return cv;
}

function buildTex(cv, job) {
  const education = cv.education
    .map(
      (e) =>
        `    \\resumeSubheading\n      {${escapeLatex(e.school)}}{}\n      {${escapeLatex(e.degree)}}{${escapeLatex(e.dates)}}`
    )
    .join("\n");

  const experience = cv.experience
    .map((role) => {
      const items = role.bullets.map((b) => `        \\resumeItem{${formatText(b)}}`).join("\n");
      return (
        `    \\resumeSubheading\n      {${escapeLatex(role.company)}}{${escapeLatex(role.dates)}}\n` +
        `      {${escapeLatex(role.role)}}{}\n      \\resumeItemListStart\n${items}\n      \\resumeItemListEnd`
      );
    })
    .join("\n");

  const projects = cv.projects
    .slice(0, 4)
    .map((p) => {
      const heading = escapeLatex(p.name) + (p.stack ? ` \\emph{$|$ ${escapeLatex(p.stack)}}` : "");
      return (
        `    \\resumeProjectHeading{${heading}}{}\n    \\resumeItemListStart\n` +
        `      \\resumeItem{${formatText(p.description)}}\n    \\resumeItemListEnd`
      );
    })
    .join("\n");

  const skills = cv.skills
    .map((s) => `    \\textbf{${escapeLatex(s.category)}}{: ${escapeLatex(s.items)}} \\\\`)
    .join("\n");

  return `\\documentclass[letterpaper,11pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome}
\\usepackage{multicol}
\\setlength{\\multicolsep}{-3.0pt}
\\setlength{\\columnsep}{-1pt}
\\input{glyphtounicode}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}
\\addtolength{\\oddsidemargin}{-0.6in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1.19in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.4in}
\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}
\\titleformat{\\section}{\\vspace{-7pt}\\scshape\\raggedright\\large\\bfseries}{}{0em}{}[\\color{black}\\titlerule \\vspace{0pt}]
\\pdfgentounicode=1
\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-3pt}}}}
\\newcommand{\\resumeSubheading}[4]{\\vspace{-3pt}\\item\\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\\textbf{#1} & \\textbf{\\small #2} \\\\\\textit{\\small#3} & \\textit{\\small #4} \\\\\\end{tabular*}\\vspace{-7pt}}
\\newcommand{\\resumeProjectHeading}[2]{\\vspace{-3pt}\\item\\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\\textbf{#1} & \\textbf{\\small #2} \\\\\\end{tabular*}\\vspace{-7pt}}
\\renewcommand\\labelitemi{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{0pt}}
\\begin{document}
\\begin{center}
{\\Huge\\scshape ${escapeLatex(cv.name)}}
\\\\ ${escapeLatex(job.company)} \\textbullet{} ${escapeLatex(job.role)}\\\\
\\small
\\href{mailto:${cv.email}}{\\raisebox{-0.2\\height}\\faEnvelope\\ \\underline{${escapeLatex(cv.email)}}} ~
\\href{${withScheme(cv.linkedin)}}{\\raisebox{-0.2\\height}\\faLinkedin\\ \\underline{${escapeLatex(cv.linkedin)}}} ~
\\href{${withScheme(cv.github)}}{\\raisebox{-0.2\\height}\\faGithub\\ \\underline{${escapeLatex(cv.github)}}}
\\end{center}
\\section{Education}
\\resumeSubHeadingListStart
${education}
\\resumeSubHeadingListEnd
\\section{Work Experience}
\\resumeSubHeadingListStart
${experience}
\\resumeSubHeadingListEnd
\\section{Personal Projects}
\\resumeSubHeadingListStart
${projects}
\\resumeSubHeadingListEnd
\\section{Technical Skills}
\\vspace{-7pt}
\\begin{itemize}[leftmargin=0.15in, label={}]\\small{\\item{
${skills}
}}
\\end{itemize}
\\end{document}
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const careerOpsDir = args["career-ops"];
  const company = args.company || "Company";
  const role = args.role || "Role";

  if (!careerOpsDir || !existsSync(careerOpsDir)) {
    console.log(JSON.stringify({ ok: false, error: `career-ops dir not found: ${careerOpsDir}` }));
    process.exit(1);
  }

  const cvPath = join(careerOpsDir, "cv.md");
  if (!existsSync(cvPath)) {
    console.log(JSON.stringify({ ok: false, error: `cv.md not found at ${cvPath}` }));
    process.exit(1);
  }

  try {
    const cvText = await readFile(cvPath, "utf-8");
    const cv = parseCvMd(cvText);
    const tex = buildTex(cv, { company, role });

    const outDir = join(careerOpsDir, "output");
    await mkdir(outDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const base = `quest-${slugify(company)}-${slugify(role)}-${date}`;
    const texPath = join(outDir, `${base}.tex`);
    const pdfPath = join(outDir, `${base}.pdf`);

    const { writeFile } = await import("fs/promises");
    await writeFile(texPath, tex, "utf-8");

    execFileSync("node", [join(careerOpsDir, "generate-latex.mjs"), texPath, pdfPath], {
      cwd: careerOpsDir,
      stdio: "pipe",
      timeout: 120_000,
    });

    console.log(JSON.stringify({ ok: true, pdf: resolve(pdfPath), tex: resolve(texPath) }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err.message || err) }));
    process.exit(1);
  }
}

main();
