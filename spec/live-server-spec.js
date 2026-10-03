const fs = require("fs");
const os = require("os");
const path = require("path");
const main = require("../lib/main");
const { LiveLspClient, fileUri } = require("./helpers/live-lsp-client");

const DIAGNOSTIC_SCOPES = [".source.python", ".source.python.ipy"];

describe("ide-basedpyright bundled server", () => {
  let adapter, client, disposable, rootPath;
  let originalTimeout;

  beforeEach(async () => {
    jasmine.useRealClock();
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    // A cold Basedpyright process can take more than 15 seconds to finish its
    // dynamic capability registration on a loaded Windows CI runner.
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ide-basedpyright-live-"));
    await lumine.packages.activatePackage("ide-basedpyright");
    disposable = main.consumeIdeClient({
      registerAdapter(registered) {
        adapter = registered;
        return { dispose() {} };
      },
    });
    client = new LiveLspClient(adapter, rootPath);
  });

  afterEach(async () => {
    await client.stop();
    disposable.dispose();
    lumine.config.unset("ide-basedpyright.analysis.diagnosticMode");
    lumine.config.unset("ide-basedpyright.features.diagnostics");
    for (const scopeSelector of DIAGNOSTIC_SCOPES)
      lumine.config.unset("ide-basedpyright.features.diagnostics", { scopeSelector });
    await lumine.packages.deactivatePackage("ide-basedpyright");
    fs.rmSync(rootPath, { recursive: true, force: true });
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });

  it("advertises and serves Basedpyright's complete shared IDE surface", async () => {
    lumine.config.set("ide-basedpyright.analysis.diagnosticMode", "workspace");
    const filePath = path.join(rootPath, "example.py");
    const source = 'answer: int = "wrong"\nanswer.bi';
    fs.writeFileSync(filePath, source);
    const { capabilities, serverInfo } = await client.start();
    expect(serverInfo.name).toBe("basedpyright");
    expect(capabilities.notebookDocumentSync.notebookSelector[0].cells).toEqual([
      { language: "python" },
    ]);
    expect(capabilities.callHierarchyProvider).toBe(true);
    expect(capabilities.inlayHintProvider).toBe(true);
    expect(capabilities.semanticTokensProvider.full).toBe(true);
    expect(capabilities.documentOnTypeFormattingProvider.firstTriggerCharacter).toBe("{");

    const uri = fileUri(filePath);
    client.open(uri, source);
    await client.waitFor(
      () => client.registrations("textDocument/diagnostic").length,
      "pull-diagnostic registration",
    );
    const diagnosticPull = client.startWorkspaceDiagnostics();
    const diagnostics = await client.waitFor(() => {
      const reports = diagnosticPull.items;
      return reports.some(({ diagnostics = [] }) =>
        diagnostics.some(({ message }) => /assign/i.test(message)),
      )
        ? reports.flatMap(({ diagnostics = [] }) => diagnostics)
        : null;
    }, "assignment diagnostic");
    expect(diagnostics.some(({ message }) => /assign/i.test(message))).toBe(true);

    const completion = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 9 },
    });
    const items = Array.isArray(completion) ? completion : completion.items;
    expect(items.map(({ label }) => label)).toContain("bit_count");
  });

  it("finishes workspace progress in push mode when diagnostics are disabled", async () => {
    lumine.config.set("ide-basedpyright.analysis.diagnosticMode", "workspace");
    for (const scopeSelector of DIAGNOSTIC_SCOPES)
      lumine.config.set("ide-basedpyright.features.diagnostics", false, { scopeSelector });
    const filePath = path.join(rootPath, "example.py");
    const source = 'answer: int = "wrong"\nprint(answer)\n';
    fs.writeFileSync(filePath, source);

    await client.start();
    const uri = fileUri(filePath);
    client.open(uri, source);
    await Promise.all([
      client.request("textDocument/documentSymbol", { textDocument: { uri } }),
      client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
      client.request("textDocument/inlayHint", {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
      }),
    ]);

    const progress = await client.waitFor(() => {
      const values = client.messages("$/progress").map(({ params }) => params.value);
      return values.some(({ kind }) => kind === "end") ? values : null;
    }, "closed workspace progress");
    expect(progress.some(({ kind }) => kind === "begin")).toBe(true);
    expect(progress.some(({ kind }) => kind === "report")).toBe(true);
    expect(client.registrations("textDocument/diagnostic")).toEqual([]);
  });

  for (const { label, python, ipython, extension } of [
    { label: "Python", python: true, ipython: false, extension: "ipy" },
    { label: "IPython", python: false, ipython: true, extension: "py" },
  ]) {
    it(`drains workspace diagnostics when only ${label} diagnostics are enabled`, async () => {
      lumine.config.set("ide-basedpyright.analysis.diagnosticMode", "workspace");
      lumine.config.set("ide-basedpyright.features.diagnostics", python, {
        scopeSelector: ".source.python",
      });
      lumine.config.set("ide-basedpyright.features.diagnostics", ipython, {
        scopeSelector: ".source.python.ipy",
      });
      const pythonPath = path.join(rootPath, "workspace.py");
      fs.writeFileSync(pythonPath, 'workspace_value: int = "wrong"\n');
      const filePath = path.join(rootPath, `active.${extension}`);
      const source = 'active_value: int = "wrong"\nprint(active_value)\n';
      fs.writeFileSync(filePath, source);

      await client.start();
      await client.waitFor(
        () => client.registrations("textDocument/diagnostic").length,
        "pull-diagnostic registration",
      );
      const uri = fileUri(filePath);
      client.open(uri, source);
      const diagnosticPull = client.startWorkspaceDiagnostics();
      await Promise.all([
        client.request("textDocument/documentSymbol", { textDocument: { uri } }),
        client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
        client.request("textDocument/inlayHint", {
          textDocument: { uri },
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        }),
      ]);
      await client.waitFor(
        () => diagnosticPull.items.length,
        "workspace diagnostic partial result",
      );

      const progress = await client.waitFor(() => {
        const values = client.messages("$/progress").map(({ params }) => params.value);
        return values.some(({ kind }) => kind === "end") ? values : null;
      }, "closed workspace progress");
      expect(progress.some(({ kind }) => kind === "begin")).toBe(true);
      expect(progress.some(({ kind }) => kind === "report")).toBe(true);
    });
  }
});
