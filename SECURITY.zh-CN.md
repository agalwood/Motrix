# 安全策略

[English](SECURITY.md) | 简体中文

## 支持版本

Motrix 为当前最新发布的 Motrix Turbo v2 版本提供安全修复。较早的 v2 预发布版本和已经冻结的旧版 v1 发布线通常不再受支持；如条件允许，请先在最新版本上复现问题再提交报告。

| 版本 | 是否支持 |
| --- | --- |
| 最新发布的 Motrix Turbo v2 版本 | 是 |
| 较早的 Motrix Turbo v2 预发布版本 | 否 |
| 旧版 Motrix v1 版本 | 否 |

## 报告安全漏洞

如怀疑存在安全漏洞，请勿创建公开 Issue、Discussion 或 Pull Request。

请通过 [GitHub 私密漏洞报告](https://github.com/agalwood/Motrix/security/advisories/new)进行报告，并尽量提供以下信息：

- 受影响的 Motrix 版本、运行方式、操作系统和处理器架构；
- 受影响的组件及安全影响；
- 最小可靠复现步骤或概念验证；
- 已移除凭证、令牌、私有地址和个人路径的相关日志或截图；
- 已知的缓解措施或修复建议。

维护者会评估报告，通过私密 Advisory 保持沟通，并根据严重程度及维护资源协调修复与披露。在修复或安全公告发布之前，或双方另行约定披露之前，请对漏洞详情保密。

## 适用范围

本策略适用于 Motrix 桌面端与 Server、原生消息宿主、官方发布产物与容器镜像，以及本仓库中的第一方代码。

第三方插件或服务中的漏洞应报告给对应维护者；如果问题同时证明 Motrix 的沙箱、权限模型、更新校验或宿主集成存在漏洞，则应向 Motrix 报告。普通 Bug 和支持请求请使用公开的 [Issue 表单](https://github.com/agalwood/Motrix/issues/new/choose)或 [GitHub Discussions](https://github.com/agalwood/Motrix/discussions)。
