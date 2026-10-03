# ide-basedpyright

Basedpyright language-server adapter for Python.

Mixed `.ipy` documents are analyzed through the shared `ipython.source` AST projection. Markdown, raw and foreign magic bodies remain in the original file and are excluded from Python analysis. Python bodies keep the original file URI; projected positions and safe edits are mapped back to the editor. The projection is never executed or saved. Ordinary `.py` files keep incremental synchronization, and notebook cells retain the server's native notebook protocol. If the IPython document grammar or source service is unavailable, the adapter refuses to send mixed source as Python.

Registers the Basedpyright language server — the maintained Pyright fork with the language-server features Pylance withholds — with `ide-client`, providing completions, type-checking diagnostics, navigation, inlay hints, semantic highlighting, and refactoring for Python projects. Basedpyright reads `pyrightconfig.json` and the `[tool.basedpyright]` settings in `pyproject.toml`.

## Features

- **Server choice**: ships Basedpyright, can install a newer npm release, returns to the bundled copy when it is removed, and accepts a custom `langserver` executable.
- **Python and IPython**: serves the Python grammar and its IPython dialect.
- **Notebook support**: speaks LSP notebook sync, so with jupyter-view it analyzes Jupyter notebook cells with cross-cell context.
- **Interpreter selection**: the Python Path and Virtual Environment Path settings pick the interpreter used for analysis.
- **Import resolution**: extra search paths, a stub directory, and a typeshed override reach source layouts Basedpyright cannot infer.
- **Analysis settings**: type-checking strictness, diagnostic scope, and the include, exclude, and ignore lists map straight to Basedpyright configuration; the slow workspace-scan warning can be silenced separately.
- **Format as you type**: applies the server's brace-triggered indentation edits; Basedpyright does not provide whole-document formatting.
- **Feature switches**: any of the thirteen capabilities Basedpyright serves can be turned off, which hands it to another Python server on the same file.
- **Project sessions**: one server per project root, started lazily with the first Python editor.

## Installation

To install `ide-basedpyright` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-basedpyright`.

Install `ide-client` first.

## Services

- `ide-client`: consumed to register the Basedpyright adapter with the editor's language-server client.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
