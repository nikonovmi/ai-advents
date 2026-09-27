import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CURATED } from "./curated.js";
import { createOmdbClient } from "./omdbClient.js";
import { normalizeMovie, parseRating, parseRuntime, splitList } from "./normalize.js";
import { createServer, getMovie, randomMovie } from "./tools.js";

/**
 * Everything offline: `fetch` is a stub that records the URL it was asked for
 * and answers with whatever the test hands it.
 */

const INCEPTION = {
  Title: "Inception",
  Year: "2010",
  Runtime: "148 min",
  Genre: "Action, Adventure, Sci-Fi",
  Director: "Christopher Nolan",
  Actors: "Leonardo DiCaprio, Joseph Gordon-Levitt, Elliot Page",
  Plot: "A thief who steals corporate secrets…",
  imdbRating: "8.8",
  Ratings: [
    { Source: "Internet Movie Database", Value: "8.8/10" },
    { Source: "Rotten Tomatoes", Value: "87%" },
  ],
  imdbID: "tt1375666",
  Response: "True",
};

function stubFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(new URL(url));
    if (typeof answer === "function") return answer(new URL(url), init);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

function omdbWith(answer, options = {}) {
  const stub = stubFetch(answer);
  return { ...stub, omdb: createOmdbClient({ apiKey: "test-key", fetch: stub.fetch, ...options }) };
}

/** A real MCP client talking to the real server over an in-memory pipe. */
async function connected(t, omdb) {
  const server = createServer({ omdb });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const textOf = (result) => result.content.map((part) => part.text).join("");

// ---- normalization ---------------------------------------------------------

test("runtime is parsed to minutes, and N/A is null", () => {
  assert.equal(parseRuntime("148 min"), 148);
  assert.equal(parseRuntime("90"), 90);
  assert.equal(parseRuntime("N/A"), null);
  assert.equal(parseRuntime(undefined), null);
});

test("ratings are numbers, and N/A is null", () => {
  assert.equal(parseRating("8.8"), 8.8);
  assert.equal(parseRating("N/A"), null);
  assert.deepEqual(splitList("Action, Adventure"), ["Action", "Adventure"]);
  assert.deepEqual(splitList("N/A"), []);
});

test("a whole OMDb record normalizes to the tool's shape", () => {
  assert.deepEqual(normalizeMovie(INCEPTION), {
    title: "Inception",
    year: "2010",
    runtimeMinutes: 148,
    genres: ["Action", "Adventure", "Sci-Fi"],
    director: "Christopher Nolan",
    actors: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page"],
    plot: "A thief who steals corporate secrets…",
    imdbRating: 8.8,
    ratings: [
      { source: "Internet Movie Database", value: "8.8/10" },
      { source: "Rotten Tomatoes", value: "87%" },
    ],
    imdbId: "tt1375666",
  });
  const sparse = normalizeMovie({ ...INCEPTION, Runtime: "N/A", imdbRating: "N/A", Director: "N/A", Ratings: undefined });
  assert.equal(sparse.runtimeMinutes, null);
  assert.equal(sparse.imdbRating, null);
  assert.equal(sparse.director, null);
  assert.deepEqual(sparse.ratings, []);
});

// ---- the client ------------------------------------------------------------

test("get_movie by title sends t, y, plot and the key", async () => {
  const { omdb, calls } = omdbWith(INCEPTION);
  const movie = await getMovie({ title: "Inception", year: 2010, plot: "full" }, omdb);
  assert.equal(movie.runtimeMinutes, 148);
  const url = calls[0];
  assert.equal(url.searchParams.get("t"), "Inception");
  assert.equal(url.searchParams.get("y"), "2010");
  assert.equal(url.searchParams.get("plot"), "full");
  assert.equal(url.searchParams.get("apikey"), "test-key");
});

test("OMDb's Response:False becomes a readable error", async () => {
  const { omdb } = omdbWith({ Response: "False", Error: "Movie not found!" });
  await assert.rejects(getMovie({ title: "Nope" }, omdb), { name: "OmdbError", kind: "omdb", message: "OMDb: Movie not found!" });
});

test("a 401 with OMDb's body reports OMDb's sentence, not the status", async () => {
  const { omdb } = omdbWith(() => new Response(JSON.stringify({ Response: "False", Error: "Invalid API key!" }), { status: 401 }));
  await assert.rejects(getMovie({ imdbId: "tt1375666" }, omdb), { message: "OMDb: Invalid API key!" });
});

test("a network failure is an error that does not leak the key", async () => {
  const { omdb } = omdbWith(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  });
  const err = await getMovie({ imdbId: "tt1375666" }, omdb).catch((e) => e);
  assert.equal(err.kind, "network");
  assert.match(err.message, /Could not reach OMDb: fetch failed \(ENOTFOUND\)/);
  assert.doesNotMatch(err.message, /test-key/);
});

test("a slow OMDb times out", async () => {
  const { omdb } = omdbWith(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
    { timeoutMs: 20 }
  );
  await assert.rejects(getMovie({ imdbId: "tt1375666" }, omdb), { kind: "timeout", message: "OMDb did not answer within 20 ms." });
});

test("a missing key is an error before any request is made", async () => {
  const stub = stubFetch(INCEPTION);
  const omdb = createOmdbClient({ apiKey: () => undefined, fetch: stub.fetch });
  await assert.rejects(getMovie({ title: "Inception" }, omdb), { kind: "config", message: /OMDB_API_KEY is not set/ });
  assert.equal(stub.calls.length, 0);
});

// ---- over MCP --------------------------------------------------------------

test("the server lists three tools with JSON schemas", async (t) => {
  const client = await connected(t, omdbWith(INCEPTION).omdb);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_movie", "random_movie", "search_movies"]);
  const get = tools.find((tool) => tool.name === "get_movie");
  assert.equal(get.inputSchema.type, "object");
  assert.deepEqual(Object.keys(get.inputSchema.properties).sort(), ["imdbId", "plot", "title", "year"]);
  assert.ok(get.description.length > 80);
});

test("get_movie returns JSON text and structuredContent", async (t) => {
  const client = await connected(t, omdbWith(INCEPTION).omdb);
  const result = await client.callTool({ name: "get_movie", arguments: { imdbId: "tt1375666" } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.runtimeMinutes, 148);
  assert.equal(JSON.parse(textOf(result)).imdbRating, 8.8);
});

test("get_movie rejects both or neither of imdbId and title", async (t) => {
  const { omdb, calls } = omdbWith(INCEPTION);
  const client = await connected(t, omdb);
  for (const args of [{}, { imdbId: "tt1375666", title: "Inception" }, { plot: "full" }]) {
    const result = await client.callTool({ name: "get_movie", arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), /exactly one of imdbId or title/);
  }
  assert.equal(calls.length, 0);
});

test("input validation: bad id, bad type, page out of range", async (t) => {
  const { omdb, calls } = omdbWith(INCEPTION);
  const client = await connected(t, omdb);
  const cases = [
    ["get_movie", { imdbId: "1375666" }],
    ["search_movies", { query: "x", type: "podcast" }],
    ["search_movies", { query: "x", page: 101 }],
    ["search_movies", { query: "" }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});

test("search_movies returns at most ten normalized hits", async (t) => {
  const hits = Array.from({ length: 12 }, (_, i) => ({ Title: `Matrix ${i}`, Year: "1999", imdbID: `tt01330${String(i).padStart(2, "0")}`, Type: "movie", Poster: "N/A" }));
  const { omdb, calls } = omdbWith({ Search: hits, totalResults: "57", Response: "True" });
  const client = await connected(t, omdb);
  const result = await client.callTool({ name: "search_movies", arguments: { query: "matrix", type: "movie", page: 2 } });
  assert.equal(result.structuredContent.results.length, 10);
  assert.deepEqual(result.structuredContent.results[0], { title: "Matrix 0", year: "1999", imdbId: "tt0133000", type: "movie" });
  assert.equal(result.structuredContent.totalResults, 57);
  assert.equal(calls[0].searchParams.get("s"), "matrix");
  assert.equal(calls[0].searchParams.get("page"), "2");
});

test("OMDb errors, network failures and a missing key are isError, never a crash", async (t) => {
  const notFound = await connected(t, omdbWith({ Response: "False", Error: "Movie not found!" }).omdb);
  const a = await notFound.callTool({ name: "search_movies", arguments: { query: "zzzz" } });
  assert.equal(a.isError, true);
  assert.equal(textOf(a), "OMDb: Movie not found!");

  const down = await connected(t, omdbWith(() => { throw new TypeError("fetch failed"); }).omdb);
  const b = await down.callTool({ name: "get_movie", arguments: { title: "Inception" } });
  assert.equal(b.isError, true);
  assert.match(textOf(b), /Could not reach OMDb/);

  const keyless = await connected(t, createOmdbClient({ apiKey: "", fetch: stubFetch(INCEPTION).fetch }));
  const c = await keyless.callTool({ name: "random_movie", arguments: {} });
  assert.equal(c.isError, true);
  assert.match(textOf(c), /OMDB_API_KEY is not set/);
});

// ---- random_movie ----------------------------------------------------------

test("random_movie picks from the curated pool and fetches by id", async () => {
  const { omdb, calls } = omdbWith(INCEPTION);
  await randomMovie({ genre: "Horror" }, omdb, () => 0);
  const id = calls[0].searchParams.get("i");
  assert.ok(CURATED.find((movie) => movie.imdbId === id).genres.includes("horror"));
  assert.ok(CURATED.length >= 28);
});

test("random_movie with an unknown genre names the ones it has", async () => {
  const { omdb, calls } = omdbWith(INCEPTION);
  await assert.rejects(randomMovie({ genre: "polka" }, omdb), /No curated titles for genre "polka". Try one of: .*sci-fi/);
  assert.equal(calls.length, 0);
});
