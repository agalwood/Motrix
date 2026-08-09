import { hooks } from 'motrix:plugin-api'

hooks.beforeCreate(async (ctx) => {
  try {
    await ctx.update({ headers: [{ name: 'X-Audit', value: 'should-fail' }] })
  } catch (_e) {
    // Audit role cannot mutate — bridge rejects via AuditRoleCannotMutate.
    // The chain remains successful (audit failures are fail-open isolated),
    // and the orchestrator drops this plugin's staged effects (there are none).
  }
})
