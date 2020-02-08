# Motrix 贡献指南

开始贡献之前，确保你已经理解了 [GitHub 的协作流程](https://guides.github.com/introduction/flow/)。

## 🌍 翻译指南

首先你要确定一个语言的英文简写作为 **locale**，如 en-US，这个 locale 值请严格参考 [Electron 的 Locales 文档](https://electronjs.org/docs/api/locales)

Motrix 的国际化分两部分：

- Element UI
- 菜单和主界面

### Element UI

Element UI 的国际化由 [Element 社区](http://element.eleme.io/#/en-US/component/i18n)提供，找到 **locale** 对应的语言包文件「两者 locale 命名可能不一致」，在 `src/shared/locales/all.js` 中引入，如

```javascript
import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
```

### 菜单和主界面

Motrix 使用 i18next 作为翻译支持库，所以你可能需要简单了解一下它的[使用方法](https://www.i18next.com/overview/getting-started)。
配置文件按照语言 (**locale**) 划分目录：`src/shared/locales`，如：`src/shared/locales/en-US` 和 `src/shared/locales/zh-CN`。

目录里面有按业务模块划分的语言文件

菜单模块经过重构之后，国际化已经打散到了以下文件里了，不再需要再复制 `src/main/menus` 里的配置。

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
