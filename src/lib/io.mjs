export function printJson(value, compact = false) {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

export function parseOptions(tokens) {
  const options = {};
  const positionals = [];
  let passthrough = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--") {
      passthrough = tokens.slice(index + 1);
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return { options, positionals, passthrough };
}

export function readBoolOption(options, key) {
  return options[key] === true;
}

export function lastLines(text, count) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}
