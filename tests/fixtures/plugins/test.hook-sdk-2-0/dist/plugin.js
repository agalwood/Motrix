import { commands, hooks, storage } from "motrix:plugin-api";
const observations = [];
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
}
hooks.beforeCreate(async (ctx) => {
  if (ctx.filename === "late") {
    setTimeout(async () => {
      try {
        await storage.get("late");
        observations.push({ hook: "late-capability", code: "unexpected-ok" });
      } catch (error) {
        observations.push({ hook: "late-capability", code: errorCode(error) });
      }
    }, 5);
    return ctx;
  }
  if (ctx.filename === "late-promise") {
    void storage.get("late").then(async () => {
      try {
        await storage.set("late-write", true);
        observations.push({ hook: "late-promise", code: "unexpected-ok" });
      } catch (error) {
        observations.push({ hook: "late-promise", code: errorCode(error) });
      }
    });
    return ctx;
  }
  if (ctx.filename === "abort") {
    await new Promise((resolve) => {
      const removed = () => observations.push({ hook: "removed-listener" });
      ctx.signal.addEventListener("abort", removed);
      ctx.signal.removeEventListener("abort", removed);
      ctx.signal.onabort = () => observations.push({
        hook: "onabort",
        aborted: ctx.signal.aborted,
        reason: String(ctx.signal.reason)
      });
      ctx.signal.addEventListener("abort", () => {
        observations.push({ hook: "abort-listener" });
        resolve();
      });
    });
    return ctx;
  }
  const metadata = ctx.metadata;
  const allBefore = metadata.getAll();
  metadata.set("sdk20", { count: 1 });
  const hasAfterSet = metadata.has("sdk20");
  const allAfter = metadata.getAll();
  metadata.delete("seed");
  ctx.update({
    filename: `${String(allBefore.seed)}-${String(
      allAfter.sdk20.count
    )}`
  });
  observations.push({
    hook: "beforeCreate",
    hasAfterSet,
    keys: [...metadata.keys()],
    aborted: ctx.signal.aborted
  });
  return ctx;
});
hooks.beforeFinalize(async (ctx) => {
  observations.push({
    hook: "beforeFinalize",
    sourceUrl: ctx.sourceUrl,
    taskId: ctx.task.id,
    saveDir: ctx.task.saveDir,
    metadata: ctx.metadata.getAll()
  });
  ctx.update({ filePath: `${ctx.filePath}.sdk20` });
  return ctx;
});
hooks.afterComplete(async (ctx) => {
  observations.push({
    hook: "afterComplete",
    taskId: ctx.task.id,
    filePath: ctx.filePath,
    keys: [...ctx.metadata.keys()]
  });
});
hooks.onError(async (ctx) => {
  observations.push({
    hook: "onError",
    taskId: ctx.task.id,
    errorCode: ctx.error.code,
    metadata: ctx.metadata.getAll()
  });
});
commands.register("test.hook-sdk-2-0.read", () => observations);
commands.register("test.hook-sdk-2-0.self-call", async () => {
  try {
    await commands.execute("test.hook-sdk-2-0.read");
    return { code: "unexpected-ok" };
  } catch (error) {
    return { code: errorCode(error) };
  }
});
commands.register("test.hook-sdk-2-0.url", () => {
  const url = new URL(
    "../archive.zip?part=1&part=2#download",
    "https://user:pass@example.test:8443/a/b/page.html"
  );
  const params = new URLSearchParams("a=1&a=2");
  params.append("b", "hello world");
  return {
    href: url.href,
    protocol: url.protocol,
    origin: url.origin,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    username: url.username,
    password: url.password,
    string: url.toString(),
    json: url.toJSON(),
    part: url.searchParams.getAll("part"),
    params: params.toString(),
    paramsAll: params.getAll("a")
  };
});
