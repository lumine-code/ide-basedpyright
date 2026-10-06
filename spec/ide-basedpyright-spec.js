const { serverContext } = require("./helpers/server-context");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveServer: resolveServerWithContext, managedServer } = require("../lib/server");
const resolveServer = (configuredPath, managedServer = null) =>
  resolveServerWithContext(serverContext({ rootPath: __dirname, managedServer }), configuredPath);

const main = require("../lib/main");

const register = () => {
  let adapter;
  const service = {
    registerAdapter(registered) {
      adapter = registered;
      return { dispose() {} };
    },
    getSessions: () => [],
    restart: async () => {},
  };
  const disposable = main.consumeIde(service);
  return { adapter, disposable };
};

describe("ide-basedpyright documentation projections", () => {
  let adapter;
  let disposable;

  beforeEach(() => {
    ({ adapter, disposable } = register());
  });
  afterEach(() => disposable.dispose());

  it("recognizes console examples in Python and unlabeled documentation blocks", () => {
    const contexts = [
      { scopeName: "source.python", language: "python" },
      { scopeName: "source.python.ipy", language: "ipython" },
      { scopeName: "text.plain", language: "pycon" },
      { language: "python-console" },
      { scopeName: "text.plain" },
      {},
    ];
    for (const context of contexts) {
      const projection = adapter.getDocumentationCodeBlockProjection({
        text: "\n>>> print(1)\n1",
        ...context,
      });
      expect(projection.scopeName).toBe("source.python");
      expect(projection.text).toBe("\nprint(1)\n");
    }
  });

  it("respects explicit non-Python fences, even when their input is valid Python", () => {
    for (const context of [
      { scopeName: "source.haskell", language: "haskell" },
      { scopeName: "source.js", language: "javascript" },
      { scopeName: "text.plain", language: "text" },
      { language: "unknown" },
    ]) {
      expect(
        adapter.getDocumentationCodeBlockProjection({ text: ">>> reverse [1, 2, 3]", ...context }),
      ).toBeNull();
    }
  });

  it("requires the first nonblank line to be a separated primary prompt", () => {
    for (const text of [
      "",
      "   \n",
      ">>>value",
      "... print(1)",
      "Example:\n>>> print(1)",
      "value >>> 1",
      "(function) def example() -> None",
    ]) {
      expect(
        adapter.getDocumentationCodeBlockProjection({ text, scopeName: "source.python" }),
      ).toBeNull();
    }
  });

  it("maps prompts and input back to CRLF documentation while leaving output neutral", () => {
    const text =
      "  >>> for item in [1, 2]:\r\n  ...     print(item)\r\n  1\r\n  ... output\r\n  >>> done = True\r\n";
    const projection = adapter.getDocumentationCodeBlockProjection({ text });
    expect(projection.text).toBe("for item in [1, 2]:\n    print(item)\n\n\ndone = True\n");

    const prompts = projection.regions.filter((region) => region.scopes);
    expect(prompts.map(({ start, end }) => text.slice(start, end))).toEqual([">>>", "...", ">>>"]);
    for (const prompt of prompts)
      expect(prompt.scopes).toEqual(["source.python", "punctuation.definition.prompt.python"]);

    const input = projection.regions.filter((region) => region.projectedStart !== undefined);
    expect(input.map(({ start, end }) => text.slice(start, end))).toEqual([
      "for item in [1, 2]:",
      "    print(item)",
      "done = True",
    ]);
    for (const region of input)
      expect(
        projection.text.slice(
          region.projectedStart,
          region.projectedStart + region.end - region.start,
        ),
      ).toBe(text.slice(region.start, region.end));

    for (const output of ["  1", "  ... output"]) {
      const start = text.indexOf(output);
      expect(
        projection.regions.some(
          (region) => region.start < start + output.length && region.end > start,
        ),
      ).toBe(false);
    }
  });

  it("stops continuations at output and resumes only at a matching primary prompt", () => {
    const text = "\t>>> first = 1\n ... wrong_indent\n\t... output\n\t>>> second = 2";
    const projection = adapter.getDocumentationCodeBlockProjection({ text });
    expect(projection.text).toBe("first = 1\n\n\nsecond = 2");
    expect(
      projection.regions
        .filter((region) => region.scopes)
        .map(({ start, end }) => text.slice(start, end)),
    ).toEqual([">>>", ">>>"]);
  });

  it("lets the renderer reject a projection that produces no parsed input", () => {
    const projection = adapter.getDocumentationCodeBlockProjection({ text: ">>>\n..." });
    expect(projection.text).toBe("\n");
    expect(projection.validate({ namedChildCount: 0 })).toBe(false);
    expect(projection.validate({ namedChildCount: 1 })).toBe(true);
  });
});

describe("ide-basedpyright IPython source service", () => {
  const leases = [];
  afterEach(() => {
    for (const lease of leases.splice(0).reverse()) lease.dispose();
  });
  const editor = (scopeName, filePath) => ({
    getGrammar: () => ({ scopeName }),
    getPath: () => filePath,
  });
  it("uses the selected grammar rather than the filename to request IPython projections", () => {
    const { adapter } = register();
    expect(adapter.needsDocumentTransform(editor("source.python", "plain.py"))).toBe(false);
    expect(adapter.needsDocumentTransform(editor("source.python.ipy", "mixed.ipy"))).toBe(true);
    expect(adapter.needsDocumentTransform(editor("source.python", "mixed.ipy"))).toBe(false);
    expect(adapter.needsDocumentTransform(editor("source.python.ipy", "mixed.py"))).toBe(true);
  });
  it("uses root scopes before falling back to an unclassified IPython filename", () => {
    const { adapter } = register();
    const scoped = (scopes) => ({
      getRootScopeDescriptor: () => ({ getScopesArray: () => scopes }),
      getPath: () => "mixed.ipy",
    });
    expect(adapter.needsDocumentTransform(scoped(["source.python"]))).toBe(false);
    expect(adapter.needsDocumentTransform(scoped(["source.python.ipy"]))).toBe(true);
    expect(adapter.needsDocumentTransform({ getPath: () => "mixed.ipy" })).toBe(true);
  });
  it("does not let disposal of an older provider remove its replacement", async () => {
    const first = { isApplicable: () => true, project: jasmine.createSpy("old projection") };
    const snapshot = { text: "value = 1", isCurrent: () => true };
    const second = {
      isApplicable: () => true,
      project: jasmine.createSpy("current projection").and.resolveTo(snapshot),
    };
    const old = main.consumeIPythonSource(first);
    leases.push(old, main.consumeIPythonSource(second));
    old.dispose();
    const { adapter } = register();
    const item = editor("source.python.ipy", "mixed.ipy");
    const signal = new AbortController().signal;
    expect(await adapter.getDocumentProjection(item, { signal })).toBe(snapshot);
    expect(second.project).toHaveBeenCalledWith(item, { signal });
    expect(first.project).not.toHaveBeenCalled();
  });
  it("refuses unavailable or stale projections rather than forwarding mixed source", async () => {
    const { adapter } = register();
    const item = editor("source.python.ipy", "mixed.ipy");
    await expectAsync(adapter.getDocumentProjection(item)).toBeRejected();
    leases.push(
      main.consumeIPythonSource({
        isApplicable: () => true,
        project: async () => ({ text: "hidden", isCurrent: () => false }),
      }),
    );
    await expectAsync(adapter.getDocumentProjection(item)).toBeRejected();
  });
});

describe("ide-basedpyright server resolution", () => {
  it("prefers the configured path", async () => {
    const launch = await resolveServer(process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe("--stdio");
    expect(launch.args[1]).toMatch(/^--cancellationReceive=file:[0-9a-f]{42}$/);
    expect(launch.fileCancellationFolder).toBe(
      path.join(os.tmpdir(), "python-languageserver-cancellation", launch.args[1].split(":")[1]),
    );
  });
  it("falls back to the bundled server module", async () => {
    const launch = await resolveServer("");
    expect(launch.command).toBe(process.execPath);
    expect(fs.existsSync(launch.args[0])).toBe(true);
    expect(launch.args[2]).toMatch(/^--cancellationReceive=file:[0-9a-f]{42}$/);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("gives concurrent servers separate cancellation channels", async () => {
    const [first, second] = await Promise.all([resolveServer(""), resolveServer("")]);
    expect(first.fileCancellationFolder).not.toBe(second.fileCancellationFolder);
  });

  it("launches a managed copy the same way as the bundled one", async () => {
    const managed = {
      modulePath: require.resolve("basedpyright/dist/pyright-langserver.js"),
      version: "1.40.999",
    };
    const launch = await resolveServer("", managed);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(managed.modulePath);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.version).toBe("1.40.999");
  });

  it("returns to the server this package ships once the managed copy is gone", async () => {
    // Uninstalling is safe precisely because this floor is always there.
    const launch = await resolveServer("", null);
    expect(fs.existsSync(launch.args[0])).toBe(true);
    expect(launch.version).toBeUndefined();
  });

  it("declares the bundled floor so uninstall is offered as a fallback", () => {
    expect(managedServer.source).toBe("npm");
    expect(managedServer.bundled).toBe(true);
    expect(managedServer.packages).toEqual(["basedpyright"]);
  });
});

describe("ide-basedpyright adapter", () => {
  let adapter;
  let disposable;

  beforeEach(async () => {
    // Applies the configSchema, so the defaults the adapter reads are the ones
    // the manifest declares rather than undefined.
    await lumine.packages.activatePackage("ide-basedpyright");
    ({ adapter, disposable } = register());
  });
  afterEach(async () => {
    disposable.dispose();
    lumine.config.unset("ide-basedpyright.analysis.warnSlowFileEnumeration");
    for (const scopeSelector of [".source.python", ".source.python.ipy"])
      lumine.config.unset("ide-basedpyright.features.diagnostics", { scopeSelector });
    await lumine.packages.deactivatePackage("ide-basedpyright");
  });

  it("registers with the language-server service", () => {
    expect(adapter.id).toBe("ide-basedpyright");
    expect(adapter.grammarScopes).toEqual(["source.python", "source.python.ipy"]);
    expect(adapter.settingsKeyPaths).toEqual(["ide-basedpyright"]);
    expect(adapter.restartKeyPaths).toEqual([
      "ide-basedpyright.serverPath",
      "ide-basedpyright.features.diagnostics",
    ]);
  });

  it("uses pull diagnostics while either served grammar has diagnostics enabled", () => {
    const combinations = [
      { python: false, ipython: false, disablePullDiagnostics: true },
      { python: true, ipython: false, disablePullDiagnostics: false },
      { python: false, ipython: true, disablePullDiagnostics: false },
      { python: true, ipython: true, disablePullDiagnostics: false },
    ];

    for (const { python, ipython, disablePullDiagnostics } of combinations) {
      lumine.config.set("ide-basedpyright.features.diagnostics", python, {
        scopeSelector: ".source.python",
      });
      lumine.config.set("ide-basedpyright.features.diagnostics", ipython, {
        scopeSelector: ".source.python.ipy",
      });

      expect(adapter.getInitializationOptions()).toEqual({ disablePullDiagnostics });
    }
  });

  it("maps editor settings into the server's configuration sections", () => {
    lumine.config.set("ide-basedpyright.analysis.typeCheckingMode", "strict");
    lumine.config.set("ide-basedpyright.analysis.extraPaths", ["src", "vendor"]);
    lumine.config.set("ide-basedpyright.pythonPath", "/usr/bin/python3");

    const settings = adapter.getSettings();
    expect(settings.python.pythonPath).toBe("/usr/bin/python3");
    expect(settings.python.analysis.typeCheckingMode).toBe("strict");
    expect(settings.python.analysis.extraPaths).toEqual(["src", "vendor"]);
    // The server pulls both spellings of both sections; every answer must
    // agree with what was pushed.
    expect(adapter.getWorkspaceConfiguration("python.analysis").extraPaths).toEqual([
      "src",
      "vendor",
    ]);
    expect(adapter.getWorkspaceConfiguration("python").pythonPath).toBe("/usr/bin/python3");
    expect(adapter.getWorkspaceConfiguration("basedpyright").pythonPath).toBe("/usr/bin/python3");
    expect(adapter.getWorkspaceConfiguration("basedpyright.analysis").extraPaths).toEqual([
      "src",
      "vendor",
    ]);
    expect(adapter.getWorkspaceConfiguration("editor")).toBeUndefined();
  });

  it("omits an unset path rather than sending an empty one", () => {
    // Basedpyright merges what it is sent over pyrightconfig.json, so an empty
    // string or list would silently win over the project's own configuration.
    const { python } = adapter.getSettings();
    expect("pythonPath" in python).toBe(true);
    expect(python.pythonPath).toBeUndefined();
    expect(python.venvPath).toBeUndefined();
    expect(python.analysis.stubPath).toBeUndefined();
    expect(python.analysis.extraPaths).toBeUndefined();
    expect(python.analysis.include).toBeUndefined();
    // Booleans have no empty state, so they are always sent.
    expect(python.analysis.useLibraryCodeForTypes).toBe(true);
  });

  it("can silence the slow workspace-enumeration warning", () => {
    expect(adapter.getWorkspaceConfiguration("basedpyright.analysis").fileEnumerationTimeout).toBe(
      undefined,
    );

    lumine.config.set("ide-basedpyright.analysis.warnSlowFileEnumeration", false);

    expect(adapter.getWorkspaceConfiguration("basedpyright.analysis").fileEnumerationTimeout).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("ide-basedpyright features", () => {
  const { configSchema } = require("../package.json");

  it("offers a switch only for what Basedpyright advertises", () => {
    // Verified against the server's own initialize response, not its docs:
    // Basedpyright 1.39.10 adds call hierarchy, inlay hints and semantic tokens
    // over open-source Pyright. Its only formatting capability is the
    // brace-triggered on-type edit; it has no whole-document formatter, code
    // lens, or type hierarchy.
    expect(Object.keys(configSchema.features.properties)).toEqual([
      "diagnostics",
      "autocomplete",
      "hover",
      "signature",
      "definition",
      "references",
      "callHierarchy",
      "symbols",
      "format",
      "rename",
      "codeActions",
      "inlayHints",
      "semanticTokens",
    ]);
  });

  it("defaults every feature on", () => {
    for (const [name, schema] of Object.entries(configSchema.features.properties))
      expect(`${name}: ${schema.default}`).toBe(`${name}: true`);
  });
});

describe("ide-basedpyright shared server resolution", () => {
  it("uses the configured server without reading an invalid managed installation", async () => {
    const getManagedServer = jasmine
      .createSpy("getManagedServer")
      .and.throwError("The managed installation is corrupt.");
    const context = serverContext({ rootPath: __dirname, getManagedServer });
    const { resolveServer: resolveWithContext } = require("../lib/server");
    const launch = await resolveWithContext(context, process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.version).toBeUndefined();
    expect(getManagedServer).not.toHaveBeenCalled();
  });

  it("reports an invalid managed installation before considering the bundled server", async () => {
    const getManagedServer = jasmine
      .createSpy("getManagedServer")
      .and.throwError("The managed installation is corrupt.");
    const context = serverContext({ rootPath: __dirname, getManagedServer });
    const { resolveServer: resolveWithContext } = require("../lib/server");
    await expectAsync(resolveWithContext(context, "")).toBeRejectedWithError(
      "The managed installation is corrupt.",
    );
    expect(getManagedServer).toHaveBeenCalledOnceWith();
  });

  it("preserves an unavailable selection as null", async () => {
    const { resolveServer: resolveWithContext } = require("../lib/server");
    const resolver = { select: jasmine.createSpy("select").and.resolveTo(null) };
    expect(await resolveWithContext({ rootPath: __dirname, resolver }, "")).toBeNull();
  });
});
