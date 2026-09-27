import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import pkg from "../package.json" with { type: "json" };
import { CURATED_GENRES, curatedPool } from "./curated.js";
import { normalizeMovie, normalizeSearch } from "./normalize.js";

/**
 * **The three tools, and the one place they are registered.**
 *
 * Handlers are plain functions of `(input, omdb)` so the tests can call them
 * without a transport; `createServer` wraps them for MCP. A handler either
 * returns data or throws, and `toolResult` is the only place either becomes a
 * `CallToolResult`: the data as JSON text plus `structuredContent`, an error as
 * `isError: true` with a sentence in it. Nothing a tool does crashes the
 * server.
 */

const IMDB_ID = /^tt\d{7,10}$/;

export const searchMoviesInput = z.object({
  query: z.string().trim().min(1).describe("Words from the title, e.g. \"matrix\" or \"the godfather\". Title search only — not actors, plots or genres."),
  year: z.number().int().min(1870).max(2100).optional().describe("Only titles released in this year."),
  type: z.enum(["movie", "series", "episode"]).optional().describe("Restrict to one kind of title."),
  page: z.number().int().min(1).max(100).optional().describe("Result page, 1-100; each page has up to 10 hits. Default 1."),
});

export const getMovieInput = z
  .object({
    imdbId: z.string().trim().regex(IMDB_ID, "an IMDb id looks like tt0133093").optional().describe("IMDb id such as \"tt0133093\". Preferred when known (e.g. from search_movies): it is exact."),
    title: z.string().trim().min(1).optional().describe("Exact-ish title; OMDb returns its single best match. Add `year` to disambiguate remakes."),
    year: z.number().int().min(1870).max(2100).optional().describe("Release year, used with `title` only."),
    plot: z.enum(["short", "full"]).optional().describe("Plot length. Default \"short\"."),
  })
  .superRefine((input, ctx) => {
    const given = Number(Boolean(input.imdbId)) + Number(Boolean(input.title));
    if (given !== 1) {
      ctx.addIssue({ code: "custom", message: "Give exactly one of imdbId or title." });
    }
  });

export const randomMovieInput = z.object({
  genre: z.string().trim().min(1).optional().describe(`Optional genre filter. One of: ${CURATED_GENRES.join(", ")}.`),
});

export async function searchMovies(input, omdb) {
  const { query, year, type, page } = searchMoviesInput.parse(input);
  return normalizeSearch(await omdb.search({ query, year, type, page }));
}

export async function getMovie(input, omdb) {
  const { imdbId, title, year, plot = "short" } = getMovieInput.parse(input);
  const data = imdbId ? await omdb.byId(imdbId, { plot }) : await omdb.byTitle(title, { year, plot });
  return normalizeMovie(data);
}

export async function randomMovie(input, omdb, random = Math.random) {
  const { genre } = randomMovieInput.parse(input ?? {});
  const pool = curatedPool(genre);
  if (!pool.length) {
    throw new Error(`No curated titles for genre "${genre}". Try one of: ${CURATED_GENRES.join(", ")}.`);
  }
  const pick = pool[Math.floor(random() * pool.length) % pool.length];
  return getMovie({ imdbId: pick.imdbId }, omdb);
}

/** Data or an error, as MCP wants it back. */
export async function toolResult(run) {
  try {
    const data = await run();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: readable(err) }],
      isError: true,
    };
  }
}

function readable(err) {
  if (err instanceof z.ZodError) {
    return "Invalid input: " + err.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");
  }
  return err?.message ?? String(err);
}

/**
 * A fresh server with the three tools on it. Stateless HTTP builds one per
 * request, which is cheap: registering three tools is a few object writes.
 *
 * @param {{ omdb: ReturnType<typeof import("./omdbClient.js").createOmdbClient> }} deps
 */
export function createServer({ omdb }) {
  const server = new McpServer({ name: "omdb-mcp", version: pkg.version });

  server.registerTool(
    "search_movies",
    {
      title: "Search OMDb",
      description:
        "Search OMDb (the IMDb-backed Open Movie Database) by title words. Returns up to 10 matches as " +
        "{ title, year, imdbId, type } plus totalResults. Use it to find the imdbId of a title, or to " +
        "disambiguate remakes and series, then call get_movie with the imdbId for details. " +
        "It does not return runtimes, ratings or plots.",
      inputSchema: searchMoviesInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => searchMovies(input, omdb))
  );

  server.registerTool(
    "get_movie",
    {
      title: "Get one movie",
      description:
        "Full details for exactly one title: title, year, runtimeMinutes (a number), genres[], director, " +
        "actors[], plot, imdbRating (a number out of 10, or null), ratings[] (IMDb, Rotten Tomatoes, " +
        "Metacritic as reported) and imdbId. Pass exactly one of imdbId (exact) or title (OMDb's best " +
        "match; add year for remakes). Use it for any factual question about runtime, rating, cast or plot " +
        "instead of answering from memory.",
      inputSchema: getMovieInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => getMovie(input, omdb))
  );

  server.registerTool(
    "random_movie",
    {
      title: "Random movie",
      description:
        "Pick a random well-known film from a curated list of about 30 classics and return the same " +
        `details as get_movie. Optional genre filter: ${CURATED_GENRES.join(", ")}. ` +
        "Use it for \"suggest something to watch\" style requests.",
      inputSchema: randomMovieInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => toolResult(() => randomMovie(input, omdb))
  );

  return server;
}
