const { resolveServer, managedServer } = require("./server");

const GRAMMAR_SCOPES = ["source.python", "source.python.ipy"];
let ipythonSource = null;
const isIPython = (editor) => {
  const scopeName = editor?.getGrammar?.()?.scopeName;
  if (scopeName) return scopeName === "source.python.ipy";
  const descriptor = editor?.getRootScopeDescriptor?.();
  const scopes = Array.isArray(descriptor) ? descriptor : descriptor?.getScopesArray?.() || [];
  if (scopes.length) return scopes.includes("source.python.ipy");
  return /\.ipy$/i.test(editor?.getPath?.() || "");
};
const needsProjection = (editor) =>
  !!editor && lumine.textEditors?.roleFor?.(editor) !== "fragment" && isIPython(editor);
const DISABLED_FILE_ENUMERATION_TIMEOUT = Number.MAX_SAFE_INTEGER;
const setting = (key) => lumine.config.get(`ide-basedpyright.${key}`);
const featureEnabledInScope = (feature, scopeName) => {
  const value = lumine.config.get(`ide-basedpyright.features.${feature}`, { scope: [scopeName] });
  return typeof value === "boolean" ? value : true;
};
const diagnosticsEnabled = () =>
  GRAMMAR_SCOPES.some((scopeName) => featureEnabledInScope("diagnostics", scopeName));

// An empty setting means "no opinion", not "the empty value": Basedpyright
// merges what it is sent over what a `pyrightconfig.json` says, so sending ""
// as a stub path or [] as an include list would silently win over the
// project's own configuration. Booleans have no empty state and are always
// sent.
const text = (key) => setting(key) || undefined;
const list = (key) => {
  const value = setting(key);
  return value?.length ? value : undefined;
};

const analysisSettings = () => ({
  typeCheckingMode: setting("analysis.typeCheckingMode"),
  diagnosticMode: setting("analysis.diagnosticMode"),
  // Basedpyright exposes the warning's delay but no off switch. Its source
  // enumerator compares elapsed milliseconds with this value in seconds, so
  // the largest exact JSON integer disables the notification without skipping
  // the scan itself.
  fileEnumerationTimeout: setting("analysis.warnSlowFileEnumeration")
    ? undefined
    : DISABLED_FILE_ENUMERATION_TIMEOUT,
  extraPaths: list("analysis.extraPaths"),
  stubPath: text("analysis.stubPath"),
  typeshedPaths: list("analysis.typeshedPaths"),
  include: list("analysis.include"),
  exclude: list("analysis.exclude"),
  ignore: list("analysis.ignore"),
  autoSearchPaths: setting("analysis.autoSearchPaths"),
  useLibraryCodeForTypes: setting("analysis.useLibraryCodeForTypes"),
  autoImportCompletions: setting("analysis.autoImportCompletions"),
  logLevel: setting("analysis.logLevel"),
});

const pythonSettings = () => ({
  pythonPath: text("pythonPath"),
  venvPath: text("venvPath"),
  analysis: analysisSettings(),
});

module.exports = {
  consumeIPythonSource(service) {
    ipythonSource = service;
    return new (require("lumine").Disposable)(() => {
      if (ipythonSource === service) ipythonSource = null;
    });
  },
  consumeIdeClient(service) {
    const adapter = {
      id: "ide-basedpyright",
      displayName: "Basedpyright Language Server",
      // Keep the real .ipy URI and Python language identifier. Its literal
      // cells are hidden by the shared AST source projection before sync.
      grammarScopes: GRAMMAR_SCOPES,
      getDocumentationCodeBlockProjection({ text, scopeName, language }) {
        return require("./documentation-projections").pythonDoctestProjection(
          text,
          scopeName,
          language,
        );
      },
      needsDocumentTransform: needsProjection,
      async getDocumentProjection(editor, { signal } = {}) {
        if (!ipythonSource?.isApplicable(editor))
          throw new Error("IPython source projection is unavailable for this document");
        const snapshot = await ipythonSource.project(editor, { signal });
        if (!snapshot?.isCurrent?.())
          throw new Error("IPython source projection is unavailable for this document");
        return snapshot;
      },
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-basedpyright"],
      // Pull diagnostics is selected during initialize, so changing its
      // feature switch has to renegotiate the session rather than merely push
      // another workspace configuration.
      restartKeyPaths: ["ide-basedpyright.serverPath", "ide-basedpyright.features.diagnostics"],
      managedServer,
      async resolveServer(context) {
        const launch = await resolveServer(setting("serverPath"), context.managedServer);
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getInitializationOptions() {
        // Basedpyright pauses workspace analysis until a pull-diagnostic
        // request arrives. When every served grammar has diagnostics switched
        // off, ask it to use push diagnostics instead: the client will still
        // hide those reports, while the analyzer can finish and close its
        // work-done progress token.
        return { disablePullDiagnostics: !diagnosticsEnabled() };
      },
      getSettings() {
        return { python: pythonSettings() };
      },
      // Basedpyright asks for both spellings; the answers are the same
      // objects, since its settings are a superset of Pyright's.
      getWorkspaceConfiguration(section) {
        if (section === "python" || section === "basedpyright") return pythonSettings();
        if (section === "python.analysis" || section === "basedpyright.analysis")
          return analysisSettings();
        return section ? lumine.config.get(section) : { python: pythonSettings() };
      },
    };

    return service.registerAdapter(adapter);
  },
};
