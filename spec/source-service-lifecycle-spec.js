const { CompositeDisposable, Disposable } = require("lumine");

describe("IPython source provider ownership", () => {
  let main, editor, adapter, leases;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("ide-basedpyright");
    main = pack.mainModule;
    leases = new CompositeDisposable();
    editor = await lumine.workspace.open();
    leases.add(
      main.consumeIde({
        registerAdapter(value) {
          adapter = value;
          return new Disposable();
        },
      }),
    );
  });

  afterEach(async () => {
    leases.dispose();
    await lumine.packages.deactivatePackage("ide-basedpyright");
    editor.destroy();
  });

  function provider(name) {
    const snapshot = { name, isCurrent: () => true };
    return {
      isApplicable: () => true,
      project: jasmine.createSpy(name).and.resolveTo(snapshot),
      snapshot,
    };
  }

  function publish(service) {
    const edge = lumine.packages.serviceHub.provide("ipython.source", "1.0.0", service);
    leases.add(edge);
    return edge;
  }

  it("keeps a shared payload available until its last ServiceHub edge retires", async () => {
    const source = provider("Shared");
    const first = publish(source);
    const second = publish(source);
    first.dispose();
    expect(await adapter.getDocumentProjection(editor)).toBe(source.snapshot);
    second.dispose();
    await expectAsync(adapter.getDocumentProjection(editor)).toBeRejected();
  });

  it("uses the newest distinct provider and falls back when it retires", async () => {
    const first = provider("First");
    const second = provider("Second");
    publish(first);
    const newer = publish(second);
    expect(await adapter.getDocumentProjection(editor)).toBe(second.snapshot);
    newer.dispose();
    expect(await adapter.getDocumentProjection(editor)).toBe(first.snapshot);
  });

  it("ignores an old manual lease after reactivation with the same payload", async () => {
    const source = provider("Shared");
    const old = main.consumeIPythonSource(source);
    leases.add(old);
    await lumine.packages.deactivatePackage("ide-basedpyright");
    const pack = await lumine.packages.activatePackage("ide-basedpyright");
    main = pack.mainModule;
    leases.add(main.consumeIPythonSource(source));
    leases.add(
      main.consumeIde({
        registerAdapter(value) {
          adapter = value;
          return new Disposable();
        },
      }),
    );
    old.dispose();
    expect(await adapter.getDocumentProjection(editor)).toBe(source.snapshot);
  });

  it("rejects a projection returned after its source edge retires", async () => {
    const source = provider("Late");
    let resolve;
    source.project.and.returnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const edge = publish(source);
    const pending = adapter.getDocumentProjection(editor);
    edge.dispose();
    resolve(source.snapshot);
    await expectAsync(pending).toBeRejected();
  });

  it("keeps a pending projection valid while one shared edge remains", async () => {
    const source = provider("Shared");
    let resolve;
    source.project.and.returnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = publish(source);
    publish(source);
    const pending = adapter.getDocumentProjection(editor);
    first.dispose();
    resolve(source.snapshot);
    expect(await pending).toBe(source.snapshot);
  });

  it("does not accept an old adapter projection after package deactivation", async () => {
    const source = provider("Late");
    let resolve;
    source.project.and.returnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    publish(source);
    const pending = adapter.getDocumentProjection(editor);
    await lumine.packages.deactivatePackage("ide-basedpyright");
    resolve(source.snapshot);
    await expectAsync(pending).toBeRejected();
  });

  it("preserves live provider errors", async () => {
    const source = provider("Failed");
    source.project.and.rejectWith(new Error("Current source failed"));
    publish(source);
    await expectAsync(adapter.getDocumentProjection(editor)).toBeRejectedWithError(
      "Current source failed",
    );
  });

  it("rejects a projection superseded by a newer source provider", async () => {
    const old = provider("Old");
    let resolve;
    old.project.and.returnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    publish(old);
    const pending = adapter.getDocumentProjection(editor);
    const newer = provider("New");
    publish(newer);
    resolve(old.snapshot);
    await expectAsync(pending).toBeRejected();
    expect(await adapter.getDocumentProjection(editor)).toBe(newer.snapshot);
  });

  it("does not invoke projection work after applicability retires the provider", async () => {
    const source = provider("Retired");
    const edge = publish(source);
    source.isApplicable = () => {
      edge.dispose();
      return true;
    };
    await expectAsync(adapter.getDocumentProjection(editor)).toBeRejected();
    expect(source.project).not.toHaveBeenCalled();
  });

  it("normalizes an obsolete provider failure to unavailable projection", async () => {
    const source = provider("Retired");
    let reject;
    source.project.and.returnValue(
      new Promise((resolve, fail) => {
        reject = fail;
      }),
    );
    const edge = publish(source);
    const pending = adapter.getDocumentProjection(editor);
    edge.dispose();
    reject(new Error("Obsolete source failed"));
    await expectAsync(pending).toBeRejectedWithError(
      "IPython source projection is unavailable for this document",
    );
  });
});
