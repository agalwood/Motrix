# 插件 Hook 运行时实施计划

状态：已通过评审的
[`plugin-hook-runtime.zh-CN.md`](plugin-hook-runtime.zh-CN.md) 的可执行计划。
任何实施步骤都不得为了通过既有测试而削弱规范性不变量。

## 1. 结果与发布门禁

只有 Electron 与 Server 构造同一个 Hook runtime、四个 Hook 通过真实
`PluginHost` 与 QuickJS Worker 执行、候选激活/权限/DTO/lane/finalize 恢复/
post delivery 满足 H1-H25、三个哈希锁定 builtin 通过真实 Hook 调用，并且第
10 节全部命令从干净 checkout 通过，工作才算完成。

本计划不复制或 cherry-pick PR #2035；既有代码只作为证据。锁定 `.moext`
仍是供应链输入，不修改 builtin 源码。

## 2. 依赖图

```text
P0 原生文件系统可行性 + 依赖安装
  -> P1 shared schema/protocol
  -> P2 matcher、permission generation、lane、按需激活
  -> P3 additive database v4 + 原子 repository
  -> P4a finalize planner/committer/recovery
  -> P4b 持久 post-delivery scheduler
  -> P5 共享 runtime/startup coordinator + task 集成
  -> P6 Electron/Server 装配
  -> P7 真实 builtin、兼容、fault、parity 与完整门禁
```

P0 后 P1/P2 可并行；P1/P3 接口稳定后 P4a/P4b 可并行。Core factory 和恢复
顺序通过测试前，不开始 shell wiring。

## 3. 工作包与文件

### P0 — 可行性与基线

- 使用 `pnpm install --frozen-lockfile` 安装 `pnpm-lock.yaml` 的精确依赖；禁止
  `npx`。
- 修改前运行当前 Hook/host/finalize/session 聚焦测试，记录 pre-existing failure。
- 若既有依赖不能提供 held no-follow handle、文件/目录 fsync、强身份与原子
  no-replace install，则在 `packages/finalize-fs/` 添加平台文件系统 helper。
  Rust/native API 只暴露 capability-style opaque handle；准入后不接受任意路径。
- Adapter contract test 必须在 Darwin/Linux/Windows 证明文件与目录 no-replace。
  不支持的 primitive 返回 typed fail-closed，绝不 fallback 到会覆盖的 rename。

门禁：修改 persistence/task 前，先用 feasibility test 证明 target 独占创建、
symlink-swap 拒绝、目录安装和 durability fault injection。

### P1 — Shared DTO、协议、Worker 与 SDK parity

新增/修改：

- `src/shared/schemas/plugin-hooks.ts`
- `src/shared/schemas/index.ts`
- `src/shared/types/plugin-hooks.ts`
- `src/core/plugin/host/bridge-protocol.ts`
- `src/core/plugin/host/quick-js-worker.ts`
- `src/core/plugin/host/capability-bridge.ts`
- 相邻 schema/protocol/Worker/bridge 测试

为 enter/exit message、`PluginTaskSnapshotV1`、`ErrorDescriptorV1`、
`DeliveryEnvelopeV1`、effect、metadata operation、上限和 canonical stable
payload 实现严格 Zod schema 与推导类型。所有 invocation-scoped message 携带
`invocationId`、call-chain ID 与 permission generation。Worker 实现 pre-Hook
六方法/post-Hook 四方法同步 `ctx.metadata`、read-after-write staging、确定性
Hook exit、指定 AbortSignal 子集和 `ctx.delivery.id`。

添加真实编译的 SDK 2.0 四 Hook 与 pinned SDK >=2.1 post-delivery fixture。若
compatible SDK minor 尚不可用，可以继续实现内部测试，但发布门禁保持阻断；
不得虚构不可发布类型后宣称契约完成。

### P2 — 结构化权限、policy barrier、lane 与激活

新增/修改：

- `src/core/plugin/permissions/host-pattern.ts` 与测试
- `src/core/plugin/hooks/eligibility.ts` 与测试
- `src/core/plugin/capabilities/http.ts` 与 redirect/proxy 测试
- `src/core/plugin/host/plugin-lane.ts` 与测试
- `src/core/plugin/host/plugin-host.ts`
- `src/core/plugin/host/activation-dispatcher.ts`
- `src/core/plugin/plugin-registry.ts`
- `src/core/plugin/grants/grants-manager.ts`
- call-chain 进入的 command graph/invoker 测试

用一个 manifest-v1 结构化 matcher 和共享 conformance corpus 替换两条 raw
regex 路径；拒绝 Guest 自选 HTTP proxy。候选从 enabled registry 而非 active
Worker 发现，只有 `beforeCreate` 使用 HTTP source matching。Hook demand 合并
activation，并能重新激活 idle-recycled Worker。

每插件建立一个供 Hook/command/lifecycle/deactivation 共用的 FIFO lane；入队前
拒绝 self/cyclic call chain。增加单调 live policy generation 与独占 mutation
barrier：关闭准入、中止 capability lease、drain/终止 lane，再发布新的 enable/
grant/executable state。Idle disposal 必须等待 lane 与 capability lease 清空。

### P3 — Additive database v4 与原子 repository

新增/修改：

- `src/core/session/migrations/v4.ts`
- `src/core/session/migrations/v4.test.ts`
- `src/core/session/migrations/index.ts`
- `src/core/session/motrix-database.ts`
- `src/core/session/motrix-database.test.ts`
- `src/core/plugin/runtime/` 下的 repository interface

只新增 table/index，不重写 task table：

- `plugin_finalize_journals`：plan、artifact identity、phase、quarantine、cleanup；
- `plugin_post_deliveries`：稳定 payload、lease、attempt、receipt、permission
  snapshot、permanent reason；
- `plugin_post_quota_ledger`：原子 row/byte reservation；
- `plugin_post_quota_buckets`：有界 daily/lifetime/global rollup；
- registry state 无法加入 SQLite transaction 时使用 lifecycle coordination journal。

提供一个事务同时提交 task 终态、task/instance path、task-file rebase、plugin
metadata、journal `db_committed`、occurrence 与 delivery row/quota tombstone。
Task 删除不得 cascade delivery。读取时校验持久 JSON，畸形行 quarantine。
Migration test 断言精确 schema、fresh install、v3 upgrade、idempotence、constraint
rollback、quota reservation 与 future-version refusal。

### P4a — Finalize plan、文件提交、补偿与恢复

新增/修改：

- `src/core/plugin/finalize/artifact-identity.ts`
- `src/core/plugin/finalize/artifact-mutation-lease.ts`
- `src/core/plugin/finalize/filesystem-adapter.ts`
- `src/core/plugin/finalize/hook-plan.ts`
- `src/core/plugin/finalize/finalize-committer.ts`
- `src/core/plugin/finalize/finalize-recovery.ts`
- `src/core/plugin/hooks/hook-orchestrator.ts`
- `src/core/plugin/hooks/staged-effects.ts`
- `src/core/plugin/hooks/staging-dir.ts`
- `src/core/task/actions/finalize-task.ts`
- 相邻 unit/integration/fault-injection 测试

Orchestrator 只校验 effect 并返回 immutable HookPlan。Committer 取得 task
artifact mutation lease，必须成功停止 engine/Host writer，记录文件/tree 强身份，
写 `prepared`，并执行 target-local no-replace install。每个动作前后与 commit/
delete 前重验身份；replacement 取代 original。任何 mismatch 都保留 byte 并
quarantine。

Recovery 在 task producer 前处理所有相邻 phase layout。测试覆盖 direct file、
单/多文件 BT、空/大 tree、source==target、case folding、symlink/reparse/special
file、EXDEV、target race、metadata/DB failure、每阶段后 mutation、补偿失败，以及
每个文件动作/fsync/journal/transaction 前后 crash。

### P4b — 可靠 post-Hook delivery

新增：

- `src/core/plugin/post/delivery-types.ts`
- `src/core/plugin/post/delivery-materializer.ts`
- `src/core/plugin/post/delivery-scheduler.ts`
- `src/core/plugin/post/delivery-retention.ts`
- `src/core/plugin/post/delivery-observability.ts`
- 相邻 deterministic clock/jitter/quota/lifecycle 测试

终态事务前在 registry generation lease 下快照候选；数据库事务准入完整 row
或有界 tombstone。Scheduler 按插件公平 claim，执行指定 lease/backoff/breaker，
进入同一 plugin lane，只为匹配 exit 写 receipt。Lease 过期回 pending；删除
task 不能删除 delivery。

执行权限是 creation snapshot 与当前 live grant 的交集。Grant revoke 中止 active
attempt；upgrade 把旧 digest row 标成 `superseded`，绝不运行旧代码。Terminal
row 立即 compact；所有 active/terminal/tombstone row+byte quota 与 core reserve
都在 admission transaction 内强制执行。

### P5 — 共享 runtime、startup coordinator 与 task 集成

新增/修改：

- `src/core/plugin/runtime/plugin-hook-runtime.ts`
- `src/core/plugin/runtime/startup-coordinator.ts`
- `src/core/plugin/runtime/runtime-factory.ts`
- `src/core/task/create-task-handler.ts`
- `src/core/task/hook-dispatch.ts`
- `src/core/task/occurrences/occurrence-dispatcher.ts`
- `src/core/session/session-manager.ts`
- 相邻 integration/order 测试

单一 factory 拥有 PluginHost、candidate resolver、lane、orchestrator、finalization、
occurrence materialization 与 post scheduler。`beforeCreate` 在持久化前接收完整
已验证请求并按 role 应用效果。`beforeFinalize` 在 engine quiesce 后、任何
rename 前执行。终态 success/error 使用单一 DB transaction；post Hook 不改变
终态。

Startup coordinator 强制：migrate -> discover/runtime -> register consumer ->
finalize recovery -> 不开放 producer 的 task/session restore -> delivery/
occurrence drain -> 开放 polling/completion producer。Shutdown 关闭准入，在预算
内 drain、持久 lease，最后停 Worker。

### P6 — Electron 与 Server 对称性

修改：

- `src/main/index.ts`
- `src/main/ipc/commands.ts`
- `src/main/plugin/capability-host.ts`
- `src/server/index.ts`
- `src/server/ipc/commands.ts`
- `src/server/plugin/capability-host.ts`
- 成对 assembly/startup-order 测试

两套 shell 调用同一 runtime factory/startup coordinator，并把同一实例注入
create/finalize/error/recovery；删除 command-local orchestrator。生产启动缺少
database/recovery/delivery/filesystem primitive 时失败；只有隔离 unit test 可注入
no-op。

### P7 — 真实验收与回归门禁

新增/修改：

- `src/core/plugin/host/e2e-builtins.test.ts`
- `src/core/plugin/host/orchestrator.e2e.test.ts`
- `src/core/task/create-task-handler.plugin-hook-e2e.test.ts`
- `src/core/plugin/host/e2e-hook-compatibility.test.ts`
- `src/main/plugin/hook-runtime-assembly.test.ts`
- `src/server/plugin/hook-runtime-assembly.test.ts`
- 按既有 test helper 约定添加本地 HTTP/TLS server 与 fault adapter

测试从 `scripts/builtins.lock.json` 读取精确 archive，并在安装前断言 size、
SHA-256、signature。构建 bundle 必须通过 PluginHost/QuickJS 真正调用：

- scraper-hook 走真实 loopback HEAD+GET，解析嵌套相对 archive URL；
- url-resolver 通过保留授权 URL/Host 的真实 loopback transport 完成 Commons
  page/API 流程，再返回独立接受的 `upload.wikimedia.org` URL；
- filename-template 同步读取 `ctx.metadata.getAll()`、渲染嵌套值、经历 idle
  recycle，并提交 no-clobber 文件与 BT 目录 rename。

Fixture callback、registration event、preview command 或源码副本都不算 builtin
Hook 验收。

## 4. 实现边界与集成顺序

各 work package 按 subsystem 保持分离，确保安全契约可以独立审查：

- **Protocol 与 schema** 覆盖 P1 DTO、Worker、Host 和 SDK parity 文件。
- **Host policy** 覆盖 P2 matching、permission、lane 与 capability gate。
- **Finalize** 覆盖 `packages/finalize-fs/`、P4a 文件和
  `finalize-task.ts`。
- **Post-delivery** 覆盖 P4b，且只依赖已发布的 repository interface。

Database migration 与 shell integration 在上述 interface 稳定后接入。跨边界修改
必须在同一 change 中更新 shared interface 及其 integration test。任何 package
都不能为了简化集成而削弱其他 package 的 invariant。

## 5. Migration、恢复与回滚

- Database v4 是 additive。Startup 在迁移前创建 timestamped pre-v4 backup，
  且验证成功后也不删除数据。
- Migration 失败时 transaction rollback，应用保持 v3；Hook runtime 与 task
  producer 都不启动。
- Finalize recovery 是 forward-only，早于 session/producer；未知/损坏 journal
  只 quarantine，不删除 byte。
- 回滚到只支持 v3 的 binary 必须恢复已验证的 pre-v4 backup；旧 binary 遇到
  future schema 必须拒绝，不能猜测。回滚前必须显式 export/reconcile v4 后的
  task 变化。
- v4 binary 内 feature rollback 停止新 Hook admission，但继续 recovery 与
  delivery/quarantine drain，不能遗弃 journal。
- Upgrade/uninstall/grant lifecycle 使用 durable barrier，崩溃后不能出现旧代码
  搭配新 grant 可执行。

## 6. 可观测性与 operator proof

按规范增加 invocation、lane、permission generation、finalize phase、recovery、
delivery lease/retry/dead-letter/quota 与 shell startup 结构化事件。去除 header、
proxy credential、secret、private source metadata 和公开文档中的绝对路径。
测试断言 Electron/Server event parity 与稳定错误分类。

## 7. 分阶段 done 条件

- P1：schema/Worker/Host/SDK field parity 与同步 metadata 测试通过。
- P2：单 matcher corpus、registry candidate、reactivation、lane、policy revoke、
  proxy、cycle 测试通过。
- P3：v4 migration 和原子 terminal/delivery/finalize transaction 测试通过。
- P4a：全部文件/目录 fault 与 mutation injection 测试通过，无 byte loss/overwrite。
- P4b：restart、duplicate、fairness、breaker、quota、lifecycle、idempotency 通过。
- P5/P6：每 shell 一个 runtime，精确 startup/shutdown 顺序测试通过。
- P7：三个锁定 builtin 真实 Hook 与 SDK 2.0/2.1 fixture 通过。
- 最终独立 reviewer 不存在未解决 correctness/security/data integrity/SDK/
  shell-drift defect。

## 8. 开发期测试命令

每个工作包后运行最小 `./node_modules/.bin/vitest run <files...>`，每次 merge 后运行对应
cluster；native helper 还需运行自身 format/lint/unit test。不得通过削弱断言，
或用 mock 替代规范要求的真实 QuickJS/HTTP/filesystem boundary 来消红。

## 9. Rollout 顺序

1. 落地 dormant schema、matcher、lane、repository、migration。
2. 在共享 factory 后落地 finalize recovery 与 post scheduler。
3. 两套 shell 与 parity test 同时 wiring，禁止单 shell rollout。
4. Startup recovery 通过后才开放真实 Hook admission。
5. 运行 builtin/compatibility/fault suite，再跑完整门禁。
6. 进行独立最终审查，修复 finding，重跑受影响测试和完整门禁。

## 10. 最终必跑命令

```text
./node_modules/.bin/vitest run <all focused Hook/runtime/finalize/post/shell suites>
pnpm run build:builtin
pnpm run check:schema-parity
pnpm run check:file-names
pnpm run check:boundaries
pnpm run lint
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
pnpm run build:electron
pnpm run build:server
pnpm run docs:check
```

在 CI 可用的每个目标平台还要运行 native filesystem package 自身 test/build。
最终报告必须列出精确命令与结果；未覆盖的平台证据作为显式残余风险。
