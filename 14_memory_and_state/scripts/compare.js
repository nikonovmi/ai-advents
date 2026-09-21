#!/usr/bin/env node
/**
 * The demo: one question, N profiles, side by side.
 *
 * The claim personalization makes is that the profile changes the answer. This
 * is the evidence, or the refutation — the same message, the same (empty)
 * history, the same persona, the same window, and the only thing varying is
 * whose long-term memory is on the wire.
 *
 *   npm run compare
 *   npm run compare -- --message="How does a bloom filter work?" --samples=3
 *   npm run compare -- --profiles=local,code-first --blocks
 *   npm run compare -- --fake        # offline, no key: shows what was sent
 *
 * Three samples per arm by default, and all of them are printed. Extraction is
 * a sampled call and so is the reply; one run of each is an anecdote, and a
 * single pair of answers that happen to differ is exactly what this harness
 * exists to stop anyone quoting.
 *
 * It is strictly read-only — `compareProfiles` wraps the profile store before
 * any arm can reach it — so running it repeatedly cannot teach the profiles
 * anything, and cannot quietly improve its own demo.
 */

import "dotenv/config";

import { personas } from "../src/agent.js";
import { compareProfiles } from "../src/context/comparison.js";
import { AnthropicProvider, FakeProvider } from "../src/llm/anthropic.js";
import { formatTokens } from "../src/llm/pricing.js";
import { defaultInvariantStore } from "../src/store/invariantStore.js";
import { defaultProfileStore } from "../src/store/profileStore.js";

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const bold = (text) => (COLOUR ? `${ESC}[1m${text}${ESC}[0m` : text);
const dim = (text) => (COLOUR ? `${ESC}[2m${text}${ESC}[0m` : text);

const DEFAULT_MESSAGE =
  "How does a bloom filter avoid false negatives? I understand the false positives part.";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const profileStore = defaultProfileStore();
const invariantStore = defaultInvariantStore();
const provider = createProvider(options);
const available = (await profileStore.list()).map((profile) => profile.id);
const wanted = options.profiles.length ? options.profiles : available.slice(0, 4);

const missing = wanted.filter((id) => !available.includes(id));
if (missing.length) {
  console.error(`No such profile: ${missing.join(", ")}. Available: ${available.join(", ") || "(none)"}.`);
  process.exit(1);
}

// **Two dimensions, one at a time.** Naming two or more projects makes the
// rule set the thing that varies and holds the profile still; that is the eval
// the README asks for — the same message under `--invariants=none` and under
// `--invariants=postgres-only`, and if the two answers do not differ visibly
// then the block is decoration and this run should be what says so.
const byProject = options.invariants.length >= 2;
const projectsAvailable = (await invariantStore.list()).map((project) => project.id);
const missingProjects = options.invariants.filter((id) => !projectsAvailable.includes(id));
if (missingProjects.length) {
  console.error(
    `No such project: ${missingProjects.join(", ")}. Available: ${projectsAvailable.join(", ") || "(none)"}.\n` +
      "Seeded ones live in data/invariants/."
  );
  process.exit(1);
}
if (!byProject && wanted.length < 2) {
  console.error(
    "A comparison needs at least two profiles, or two projects. Seeded ones live in\n" +
      "data/memory/ and data/invariants/."
  );
  process.exit(1);
}

console.log(
  `\n${bold(byProject ? "Same question, " + options.invariants.length + " rule sets" : "Same question, " + wanted.length + " profiles")}` +
    ` — ${options.samples} samples each`
);
console.log(dim(`provider: ${provider.model}${provider instanceof FakeProvider ? " (offline — reflects context, does not reason)" : ""}`));
console.log(`\n${bold("Q")} ${options.message}\n`);

const comparison = await compareProfiles({
  message: options.message,
  systemPrompt: personas.helpful,
  provider,
  profileStore,
  profiles: wanted,
  invariantStore,
  projects: options.invariants,
  samples: options.samples,
  maxTokens: options.maxTokens,
});

for (const arm of comparison.arms) {
  console.log(
    bold(arm.label) +
      dim(
        (comparison.varying === "invariants"
          ? ` — ${arm.invariantCount} invariant${arm.invariantCount === 1 ? "" : "s"}, as ${arm.user}`
          : ` — ${arm.entryCount} long-term entr${arm.entryCount === 1 ? "y" : "ies"}, ${arm.declaredCount} declared`) +
          ` · ${formatTokens(arm.usage.inputTokens)} in / ${formatTokens(arm.usage.outputTokens)} out` +
          ` · ${money(arm.usage.costUsd)}`
      )
  );

  // What went in, before what came out. The evidence is structural: nothing
  // here asks a model which preferences it used, because it would confabulate.
  const block =
    comparison.varying === "invariants" ? arm.runs[0]?.invariantsBlock : arm.runs[0]?.profileBlock;
  if (options.blocks && block) {
    console.log(dim(indent(block, "  │ ")));
  }

  for (const run of arm.runs) {
    console.log(dim(`  run ${run.run}${run.ok ? "" : " — failed"}`));
    console.log(indent(run.ok ? run.reply.trim() : run.error, "  "));
    console.log("");
  }
}

console.log(
  dim(
    `Billed to this comparison and to nothing else: ${comparison.meta.calls} calls, ` +
      `${formatTokens(comparison.meta.inputTokens + comparison.meta.outputTokens)} tokens, ` +
      `${money(comparison.meta.costUsd)}, ${(comparison.meta.ms / 1000).toFixed(1)}s. ` +
      "Nothing was written: not to a profile, not to a conversation.\n"
  )
);

function indent(text, prefix) {
  return String(text ?? "")
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function money(usd) {
  return usd ? "$" + usd.toFixed(5) : "—";
}

function createProvider({ fake }) {
  const apiKey = fake ? null : process.env.ANTHROPIC_API_KEY;
  if (apiKey) return new AnthropicProvider({ apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
  return new FakeProvider({ delayMs: 0 });
}

function parseArgs(argv) {
  const parsed = {
    message: DEFAULT_MESSAGE,
    profiles: [],
    invariants: [],
    samples: 3,
    maxTokens: 1024,
    blocks: false,
    fake: false,
    help: false,
  };

  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    switch (key) {
      case "message":
        parsed.message = value;
        break;
      case "profiles":
        parsed.profiles = value.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
        break;
      case "invariants":
        parsed.invariants = value.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
        break;
      case "samples":
        parsed.samples = Math.max(1, Math.min(5, Number(value) || 3));
        break;
      case "max-tokens":
        parsed.maxTokens = Math.max(1, Number(value) || 1024);
        break;
      case "blocks":
        parsed.blocks = true;
        break;
      case "fake":
        parsed.fake = true;
        break;
      case "help":
      case "h":
        parsed.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(1);
    }
  }

  return parsed;
}

function usage() {
  console.log(`
Usage: npm run compare -- [options]

  --message=<text>    The one question every profile is asked
  --profiles=a,b      Profile ids from data/memory/  (default: the first four)
  --invariants=a,b    Project ids from data/invariants/. Two or more of them
                      makes the RULE SET the thing that varies and holds the
                      profile still:
                        npm run compare -- --invariants=none,postgres-only
                      One of them pins that rule set for every profile arm.
  --samples=<n>       Runs per profile, 1–5                       (default: 3)
  --max-tokens=<n>    Reply ceiling                             (default: 1024)
  --blocks            Also print the <profile> block each arm was sent
  --fake              Force the offline provider even with a key set
`);
}
