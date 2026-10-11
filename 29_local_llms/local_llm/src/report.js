import { summarize } from "./bench.js";

/**
 * **day26_results.json → day26_report.md.** The findings are computed from
 * the numbers in the results, so a rerun rewrites them.
 */

const s = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(2)} s`);
const n = (x, digits = 1) => (x == null ? "–" : x.toFixed(digits));
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function summaryTable(summary) {
  const lines = [
    "| model | quant | checks passed | load time | mean TTFT | mean generation | mean total latency |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of summary) {
    lines.push(
      `| \`${r.model}\` | ${r.parameter_size ?? ""} ${r.quantization ?? ""} | ${r.passed}/${r.total} | ${s(r.load_ms)} | ${s(r.mean_ttft_ms)} | ${n(r.mean_gen_tps)} tok/s | ${s(r.mean_total_ms)} |`,
    );
  }
  return lines.join("\n");
}

/** Short, number-driven findings. */
export function findings(run, summary = summarize(run)) {
  const out = [];
  for (const r of summary) {
    const failed = run.results.filter((x) => x.model === r.model && !x.check.pass);
    out.push(
      failed.length
        ? `**${r.model}** passed ${r.passed}/${r.total}; failed ${failed.map((f) => `\`${f.request}\` (${f.check.detail})`).join(", ")}.`
        : `**${r.model}** passed all ${r.total} checks.`,
    );
  }
  if (summary.length >= 2) {
    const [fast, slow] = [...summary].sort((a, b) => (b.mean_gen_tps ?? 0) - (a.mean_gen_tps ?? 0));
    if (fast.mean_gen_tps && slow.mean_gen_tps) {
      out.push(
        `**Speed:** ${fast.model} generates ${n(fast.mean_gen_tps)} tok/s vs ${n(slow.mean_gen_tps)} tok/s for ${slow.model} ` +
          `(${n(fast.mean_gen_tps / slow.mean_gen_tps, 2)}×); mean latency ${s(fast.mean_total_ms)} vs ${s(slow.mean_total_ms)}.`,
      );
    }
    out.push(
      `**Token-weighted rates** (all tokens / all time): generation ${summary.map((r) => `${r.model} ${n(r.overall_gen_tps)}`).join(" vs ")} tok/s; ` +
        `prompt processing ${summary.map((r) => `${r.model} ${n(r.overall_prompt_tps)}`).join(" vs ")} tok/s.`,
    );
    const loads = [...summary].sort((a, b) => (a.load_ms ?? 0) - (b.load_ms ?? 0));
    out.push(`**Cold load** (warm-up, not counted): ${loads.map((r) => `${r.model} ${s(r.load_ms)}`).join(", ")}.`);
  }
  // Where generation length, not speed, decides latency.
  for (const r of summary) {
    const rs = run.results.filter((x) => x.model === r.model);
    const longest = rs.reduce((a, b) => ((b.metrics.gen_tokens ?? 0) > (a.metrics.gen_tokens ?? 0) ? b : a), rs[0]);
    if (longest) {
      const share = r.gen_tokens ? (longest.metrics.gen_tokens / r.gen_tokens) * 100 : 0;
      out.push(`${r.model}'s longest answer was \`${longest.request}\`: ${longest.metrics.gen_tokens} tokens in ${s(longest.metrics.total_ms)} (${n(share, 0)}% of all its generated tokens).`);
    }
  }
  // Only real reuse (half the prompt or more), not the few template tokens every request shares.
  const cached = run.results.filter((x) => x.metrics.cached_prompt_tokens >= x.metrics.prompt_tokens / 2);
  if (cached.length) {
    out.push(
      `Prompt cache hits: ${cached.map((x) => `${x.model} / \`${x.request}\` reused ${x.metrics.cached_prompt_tokens} of ${x.metrics.prompt_tokens} prompt tokens (prompt eval ${s(x.metrics.prompt_eval_ms)}, TTFT ${s(x.metrics.ttft_ms)})`).join("; ")}.`,
    );
  }
  const truncated = run.results.filter((x) => x.done_reason === "length");
  if (truncated.length) out.push(`Hit \`num_predict\`: ${truncated.map((x) => `${x.model} / ${x.request}`).join(", ")}.`);
  return out;
}

export function renderReport(run, requests) {
  const summary = summarize(run);
  const m = run.machine;
  const lines = [
    "# Day 26 — Local LLMs under Ollama",
    "",
    `Run ${run.started_at.slice(0, 16).replace("T", " ")} UTC on ${m.chip}, ${m.ram_gb} GB RAM, ${m.os}; Ollama ${run.ollama_version} at ${run.ollama_url}.`,
    `Temperature ${run.settings.temperature}, seed ${run.settings.seed}, think ${run.settings.think}. Models ran one at a time: warm-up (not counted), ${requests.length} requests, unload.`,
    "",
    "## Summary",
    "",
    summaryTable(summary),
    "",
    "TTFT ≈ load_duration + prompt_eval_duration (Ollama's own timings, non-streaming). Generation = eval_count / eval_duration. Total = total_duration.",
    "",
    "## Findings",
    "",
    ...findings(run, summary).map((f) => `- ${f}`),
    "",
    "## Models",
    "",
    "| model | family | parameters | quantization | format / runner | size | capabilities |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
    ...run.models.map(
      (x) => `| \`${x.name}\` | ${x.family ?? ""} | ${x.parameter_size ?? ""} | ${x.quantization ?? ""} | ${x.format ?? ""} / ${x.runner ?? ""} | ${x.size_gb ?? "–"} GB | ${x.capabilities.join(", ")} |`,
    ),
    "",
    "## Requests",
  ];
  for (const req of requests) {
    lines.push("", `### \`${req.id}\` — ${req.title}`, "");
    if (req.type === "grounded") {
      lines.push(`Passage: \`${req.passage.chunk_id}\` (${req.passage.section})`, "", `> ${req.question}`);
    } else {
      lines.push(...req.messages.at(-1).content.split("\n").map((l) => `> ${l}`));
    }
    lines.push("", `Check: \`${req.check.type}\`${req.format ? " · `format`: JSON schema" : ""}`, "");
    lines.push("| model | check | TTFT | prompt tok/s | gen tok/s | gen tokens | total |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    const rs = run.results.filter((r) => r.request === req.id);
    for (const r of rs) {
      const x = r.metrics;
      lines.push(
        `| \`${r.model}\` | ${r.check.pass ? "✅" : "❌"} ${cell(r.check.detail)} | ${s(x.ttft_ms)} | ${n(x.prompt_tps, 0)} | ${n(x.gen_tps)} | ${x.gen_tokens ?? "–"} | ${s(x.total_ms)} |`,
      );
    }
    for (const r of rs) {
      lines.push("", `**${r.model}:**`, "", "````text", r.text.trim() || "(empty)", "````");
    }
  }
  return lines.join("\n") + "\n";
}
