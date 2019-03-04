# Motrix Contributing Guide

## 🌍 Translation Guide
First you need to determine the English abbreviation of a language as **locale**, such as en-US, this locale value should strictly refer to the [electron's documentation](https://electronjs.org/docs/api/locales).

The internationalization of Motrix is divided into three parts:
- Element UI
- Application Menu
- Main Interface

### Element UI
The internationalization of Element UI is provided by the [Element community](http://element.eleme.io/#/en-US/component/i18n), then find the language pack file corresponding to **locale** (both locale naming may be inconsistent), which is import in `src/shared/locales/all.js`, such as
```
import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
```

### Application Menu
The internationalization files of the application menu are divided into directories according to the **locale**. Each directory has three JSON files corresponding to the OS:
- darwin.json
- linux.json
- win32.json

### Main Interface
Both the main interface and the Element UI use [i18next](https://www.i18next.com/overview/getting-started) as the translation support library, so you may need to take a brief look at how to use it.
The configuration of the main interface is also divided into directories according to the **locale**: `src/shared/locales`, such as: `src/shared/locales/en-US` and `src/shared/locales/zh-CN`.
There are language files in the directory divided by business modules:
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
