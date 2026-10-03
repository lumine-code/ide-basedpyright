// Map Python console examples into parseable input without changing the
// displayed documentation. Prompts get their own scopes; output stays neutral.
function pythonDoctestProjection(source, scopeName, language) {
  const python = scopeName === "source.python" || scopeName === "source.python.ipy";
  const consoleFence = language === "pycon" || language === "python-console";
  const unlabeled = !language && (!scopeName || scopeName === "text.plain");
  if (!python && !consoleFence && !unlabeled) return null;

  const lines = source.split(/(\r\n|\n|\r)/);
  let firstLine;
  for (let index = 0; index < lines.length; index += 2) {
    if (lines[index].trim()) {
      firstLine = lines[index];
      break;
    }
  }
  const firstPrompt = /^([ \t]*)>>>(?:[ \t]|$)/.exec(firstLine ?? "");
  if (!firstPrompt) return null;

  const indentation = firstPrompt[1];
  const regions = [];
  let text = "";
  let offset = 0;
  let input = false;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const newline = lines[index + 1] ?? "";
    const prompt = /^([ \t]*)(>>>|\.\.\.)(?:[ \t]|$)/.exec(line);
    if (prompt && prompt[1] === indentation && (prompt[2] === ">>>" || input)) {
      input = true;
      const promptStart = offset + indentation.length;
      regions.push({
        start: promptStart,
        end: promptStart + 3,
        scopes: ["source.python", "punctuation.definition.prompt.python"],
      });
      // Remove just the prompt and one separator. Any remaining spaces belong
      // to the Python input, especially a continuation's suite indentation.
      const start = offset + prompt[0].length;
      if (start < offset + line.length) {
        regions.push({ start, end: offset + line.length, projectedStart: text.length });
        text += line.slice(prompt[0].length);
      }
    } else {
      // Output is displayed verbatim but never parsed as Python. In particular,
      // doctest's output ellipsis after stdout is not a continuation prompt.
      input = false;
    }
    if (newline) text += "\n";
    offset += line.length + newline.length;
  }
  return {
    scopeName: "source.python",
    text,
    regions,
    validate: (root) => root.namedChildCount > 0,
  };
}

module.exports = { pythonDoctestProjection };
