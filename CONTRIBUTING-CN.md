# Motrix 贡献指南

## 🌍 翻译指南
首先你要确定一个语言的英文简写作为 **locale**，如 en-US，这个 locale 值请严格参考 [Electron 的 Locales 文档](https://electronjs.org/docs/api/locales)

Motrix 的国际化分三部分：
- Element UI
- 应用菜单
- 主界面

### Element UI
Element UI 的国际化由 [Element 社区](http://element.eleme.io/#/en-US/component/i18n)提供，找到 **locale** 对应的语言包文件「两者 locale 命名可能不一致」，在 `src/shared/locales/all.js` 中引入，如
```
import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
```

### 应用菜单
应用菜单的国际化文件按照语言进行目录划分，每个目录里有三大操作系统对应的 JSON 文件：
- darwin.json
- linux.json
- win32.json

### 主界面
主界面和 Element UI 都是用 i18next 作为翻译支持库，所以你可能需要简单了解一下它的[使用方法](https://www.i18next.com/overview/getting-started)。
主界面的配置同样按照语言划分目录：`src/shared/locales`，如：`src/shared/locales/en-US` 和 `src/shared/locales/zh-CN`。
目录里面有按业务模块划分的语言文件：
- about.js
- app.js
- edit.js
- help.js
- index.js
- menu.js
- preferences.js
- subnav.js
- task.js
- window.js
