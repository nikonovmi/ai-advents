/** `--flag`, `--key value`, and the rest as positionals. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positionals.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { flags, positionals };
}
