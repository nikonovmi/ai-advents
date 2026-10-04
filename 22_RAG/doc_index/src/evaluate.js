/**
 * **Retrieval eval: did the right chunk come back, and how high?**
 *
 * A hit is a chunk from `expected_source` (equal, or a prefix of the chunk's
 * source so a question can name a page without its long file name) whose text
 * contains `expected_text`, ignoring case and whitespace. The rank of a question
 * is the position of its first hit in the top k, or null.
 */

const norm = (s) => s.toLowerCase().replace(/\s+/g, "");

export function isHit(chunk, question) {
  const sourceOk = chunk.source === question.expected_source || chunk.source.startsWith(question.expected_source);
  return sourceOk && norm(chunk.text).includes(norm(question.expected_text));
}

/**
 * @param {Array<{ id, question, expected_source, expected_text }>} questions
 * @param {(query: string, opts: { strategy: string, k: number }) => Promise<object[]>} search
 */
export async function evaluate(questions, search, { strategies, k = 5 }) {
  const perQuestion = [];
  for (const q of questions) {
    const row = { ...q, results: {} };
    for (const strategy of strategies) {
      const hits = await search(q.question, { strategy, k });
      const index = hits.findIndex((h) => isHit(h, q));
      row.results[strategy] = {
        rank: index === -1 ? null : index + 1,
        top1: hits[0] ? { source: hits[0].source, section: hits[0].section, score: hits[0].score, token_count: hits[0].token_count } : null,
        hit: index === -1 ? null : { section: hits[index].section, token_count: hits[index].token_count, score: hits[index].score },
      };
    }
    perQuestion.push(row);
  }
  const metrics = Object.fromEntries(strategies.map((s) => [s, metricsFor(perQuestion.map((r) => r.results[s].rank))]));
  return { perQuestion, metrics, k };
}

export function metricsFor(ranks) {
  const n = ranks.length || 1;
  const at = (k) => ranks.filter((r) => r !== null && r <= k).length / n;
  return { hit1: at(1), hit3: at(3), hit5: at(5), mrr: ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n };
}
