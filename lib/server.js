const crypto = require("crypto");
const os = require("os");
const path = require("path");

// Where the editor can fetch a newer Basedpyright than the one this package
// pins.
//
// Unlike the Rust servers, this is an *upgrade tier* rather than the only way
// to get one: the `basedpyright` dependency below is always present, so
// uninstalling drops back to it and can never leave the user with nothing.
// What it buys is independence from this package's release cadence —
// Basedpyright tracks Pyright's roughly weekly releases, and a repin is
// otherwise the only way to follow it.
//
// `basedpyright` declares no required runtime dependency (only an optional
// `fsevents`, whose absence it reports and works around), so extracting the
// published tarball is the whole install.
exports.managedServer = {
  source: "npm",
  displayName: "Basedpyright",
  packages: ["basedpyright"],
  module: "node_modules/basedpyright/dist/pyright-langserver.js",
  bundled: true,
};

exports.resolveServer = async (context, configuredPath) => {
  const selection = await context.resolver.select({
    configuredPath,
    configuredKind: "auto",
    managedPath: context.managedServer?.modulePath,
    managedVersion: context.managedServer?.version,
    bundledPath: () => require.resolve("basedpyright/dist/pyright-langserver.js"),
    kind: "node",
    allowShellWrapper: true,
  });
  if (!selection) return null;
  // Every process generation owns a separate worker cancellation channel.
  const cancellationName = crypto.randomBytes(21).toString("hex");
  return context.resolver.launch(selection, {
    args: ["--stdio", `--cancellationReceive=file:${cancellationName}`],
    cwd: context.rootPath,
    transport: "stdio",
    fileCancellationFolder: path.join(
      os.tmpdir(),
      "python-languageserver-cancellation",
      cancellationName,
    ),
  });
};
