import { commands, hooks } from "motrix:plugin-api";
const observations = [];
function observe(ctx, hook) {
  observations.push({
    hook,
    deliveryId: ctx.delivery.id,
    occurrenceId: ctx.delivery.occurrenceId,
    occurredAt: ctx.delivery.occurredAt,
    metadataReadonly: typeof Reflect.get(ctx.metadata, "set") === "undefined" && typeof Reflect.get(ctx.metadata, "delete") === "undefined",
    ...hook === "onError" && "error" in ctx ? { errorCode: ctx.error.code } : {}
  });
}
hooks.afterComplete(async (ctx) => observe(ctx, "afterComplete"));
hooks.onError(async (ctx) => observe(ctx, "onError"));
commands.register("test.hook-delivery-runtime.read", () => observations);
