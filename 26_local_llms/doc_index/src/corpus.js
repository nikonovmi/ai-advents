import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PROJECT_DIR, PROJECTS_RAW_DIR, RAW_DIR, knowledgeDir, loadSources } from "./config.js";
import { loadCode } from "./loaders/code.js";
import { loadHtml, MIN_TEXT_CHARS } from "./loaders/html.js";
import { loadMarkdown } from "./loaders/markdown.js";
import { loadPdf } from "./loaders/pdf.js";

/**
 * **sources.json → files on disk → normalised documents.**
 *
 * Three collections:
 * - `knowledge`: the HTML pages in `knowledge_database/`, read in place and
 *   never written to;
 * - `projects`: our READMEs, PROMPTs and source files, copied into
 *   `corpus/raw/projects/` by `npm run fetch`;
 * - `downloads`: files fetched from a URL into `corpus/raw/` (the PDF).
 *
 * `gatherCorpus` is the fetch step; `loadCorpus` is the load step, and it
 * names every file it could not use rather than dropping it silently.
 */

const exists = (p) => fs.existsSync(p);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walk(dir, keep) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, keep));
    else if (keep(full, entry.name)) out.push(full);
  }
  return out.sort();
}

const globToRegex = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** The project files sources.json asks for, as paths relative to its root. */
export function projectFiles(sources = loadSources()) {
  const { root, files = [], dirs = [], skip = [] } = sources.projects;
  const base = path.resolve(PROJECT_DIR, root);
  const skips = skip.map(globToRegex);
  const skipped = (rel) => rel.split("/").some((part) => skips.some((re) => re.test(part)));
  const out = new Set(files.filter((f) => exists(path.join(base, f))));
  for (const { dir, extensions } of dirs) {
    for (const full of walk(path.join(base, dir), (f) => extensions.includes(path.extname(f)))) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (!skipped(rel)) out.add(rel);
    }
  }
  return { base, files: [...out].sort() };
}

/**
 * `npm run fetch`. Idempotent: a download that exists is skipped, a copy whose
 * content is unchanged is skipped; `force` redoes everything.
 */
export async function gatherCorpus({ force = false, log = console.log, sources = loadSources(), fetchImpl = fetch } = {}) {
  fs.mkdirSync(PROJECTS_RAW_DIR, { recursive: true });
  const summary = { downloaded: 0, copied: 0, skipped: 0 };

  for (const d of sources.downloads ?? []) {
    const target = path.join(RAW_DIR, d.file);
    if (exists(target) && !force) {
      log(`skip     ${d.file} (exists)`);
      summary.skipped++;
      continue;
    }
    log(`download ${d.url}`);
    const res = await fetchImpl(d.url);
    if (!res.ok) throw new Error(`${d.url}: HTTP ${res.status}`);
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    summary.downloaded++;
  }

  const { base, files } = projectFiles(sources);
  for (const rel of files) {
    const from = path.join(base, rel);
    const to = path.join(PROJECTS_RAW_DIR, rel);
    const content = fs.readFileSync(from);
    if (!force && exists(to) && sha(fs.readFileSync(to)) === sha(content)) {
      summary.skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
    log(`copy     ${rel}`);
    summary.copied++;
  }

  const kb = knowledgeDir(sources);
  const pages = knowledgeFiles(kb, sources);
  log(`knowledge: ${pages.length} HTML files read in place from ${path.relative(PROJECT_DIR, kb) || "."}`);
  log(`fetch: ${summary.downloaded} downloaded, ${summary.copied} copied, ${summary.skipped} unchanged`);
  return summary;
}

export function knowledgeFiles(dir, sources = loadSources()) {
  const exts = sources.knowledge.extensions ?? [".html", ".htm"];
  return walk(dir, (f) => exts.includes(path.extname(f).toLowerCase()));
}

/**
 * Every source → normalised documents, each tagged with its `collection`.
 * Files that yield (almost) no text, and exact duplicates, are reported in
 * `warnings` and left out.
 */
export async function loadCorpus({ sources = loadSources(), log = console.warn } = {}) {
  const documents = [];
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    log(`warning: ${msg}`);
  };

  const kb = knowledgeDir(sources);
  if (!exists(kb)) warn(`knowledge folder not found: ${kb} (set KNOWLEDGE_DIR)`);
  for (const full of knowledgeFiles(kb, sources)) {
    const relPath = path.relative(kb, full);
    const doc = loadHtml(fs.readFileSync(full, "utf8"), { relPath });
    if (doc.text.length < MIN_TEXT_CHARS) {
      warn(`${doc.source}: only ${doc.text.length} characters after cleanup ("${doc.title}"), not indexed`);
      continue;
    }
    documents.push({ ...doc, collection: "knowledge" });
  }

  for (const full of walk(PROJECTS_RAW_DIR, () => true)) {
    const rel = path.relative(PROJECTS_RAW_DIR, full).split(path.sep).join("/");
    const content = fs.readFileSync(full, "utf8");
    const ext = path.extname(full).toLowerCase();
    if (ext === ".md") documents.push({ ...loadMarkdown(content, { relPath: rel }), collection: "projects" });
    else if (ext === ".js") documents.push({ ...loadCode(content, { relPath: rel }), collection: "projects" });
    else warn(`${rel}: no loader for "${ext}"`);
  }
  if (!exists(PROJECTS_RAW_DIR)) warn("corpus/raw/projects/ is missing: run npm run fetch");

  for (const d of sources.downloads ?? []) {
    const file = path.join(RAW_DIR, d.file);
    if (!exists(file)) {
      warn(`${d.file} is missing: run npm run fetch`);
      continue;
    }
    if (d.format !== "pdf") {
      warn(`${d.file}: no loader for format "${d.format}"`);
      continue;
    }
    documents.push({ ...(await loadPdf(fs.readFileSync(file), { id: d.id, title: d.title, source: d.url })), collection: "downloads" });
  }

  const seen = new Map();
  const unique = [];
  for (const doc of documents) {
    const key = sha(doc.text);
    if (seen.has(key)) {
      warn(`${doc.source} has the same text as ${seen.get(key)}, not indexed twice`);
      continue;
    }
    seen.set(key, doc.source);
    unique.push(doc);
  }
  return { documents: unique, warnings };
}
