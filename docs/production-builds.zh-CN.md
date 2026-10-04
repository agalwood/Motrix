# 生产构建

Motrix 构建六类 JavaScript 产物：Electron 主进程、preload、插件 worker、
桌面渲染器、Web 渲染器，以及包含运维 CLI 的 Node 服务端。
这些 Vite 配置共用 `scripts/vite-production-output.ts`。

## 产物策略

- 生产 JavaScript 统一压缩，包括服务端 ES library 产物中的空白。
  渲染器 CSS 使用 Lightning CSS 压缩。
- 输出的 JavaScript 移除源码文档注释和优化器注解，保留许可证注释及
  安装包中的第三方声明。
- 发布构建不生成 source map。服务端保留函数名和类名，便于诊断；
  运行日志继续保留。
- 只有渲染器构建复制 `public/` 中的图标和图片。宿主、preload 和 worker
  构建不复制这些浏览器资源，避免安装包包含重复文件。
- 主进程、preload 和 worker 入口仍为 CommonJS `.cjs` 文件，服务端和 CLI
  入口仍为 ES `.mjs` 文件。原生模块和外部依赖继续遵循现有打包规则。

## 按需加载的资源

英文和简体中文翻译随应用预加载。其余 24 种语言拆为独立代码块，包含在
桌面安装包中，由 Motrix Server 本地提供给 Web 界面。桌面端切换语言无需联网。

宿主和渲染器先加载目标翻译，再应用语言变更。同一资源的并发请求共享加载过程，
加载失败后可以重试；渲染器较慢的旧请求不会覆盖较新的语言选择。
运维 CLI 在创建翻译器前加载所选语言。插件提供的翻译沿用现有生命周期。

插件诊断首次需要计算图布局时才加载 ELK 布局引擎。复用已缓存的图布局时，
不会再次加载或运行引擎。

代码拆分减少启动时需要解析的 JavaScript，不会从安装包中删除语言或功能。
额外的代码块封装可能让渲染器产物总体积略有增加。

## 测量与验证

在仓库根目录运行：

```bash
NODE_ENV=production node scripts/measure-production-bundles.mjs
pnpm exec vitest run tests/scripts/production-build.test.ts
pnpm build
pnpm test:e2e e2e/unit-localization.spec.ts e2e/plugin-call-graph.spec.ts
```

测量命令在内存中构建六类产物，报告 JavaScript 原始及 gzip 字节数、代码块数量、
包含的语言和启动依赖。初始字节数包含所有入口及其递归静态导入，不计动态导入。
服务端数值是 Server 和 CLI 两个入口的合集，并非单个运行进程的测量。
gzip 字节数为各代码块独立压缩后的总和，不代表安装包体积。

CI 检查初始及完整 JavaScript 体积预算，确认 26 种语言均被打包、延迟语言和 ELK
未进入初始代码块，并拒绝生成 source map 或向宿主产物复制浏览器资源。
服务端构建夹具还验证压缩后源码文档已移除，而许可证声明、诊断名称和执行行为
仍然保留。各平台的包验证与运行冒烟测试继续负责检查安装体积及原生运行时兼容性。
