# Motrix Contributing Guide

## 🌍 Translation Guide

First you need to determine the English abbreviation of a language as **locale**, such as en-US, this locale value should strictly refer to the [electron's documentation](https://electronjs.org/docs/api/locales).

The internationalization of Motrix is divided into two parts:

- Element UI
- Menu & Main Interface

### Element UI

The internationalization of Element UI is provided by the [Element community](http://element.eleme.io/#/en-US/component/i18n), then find the language pack file corresponding to **locale** (both locale naming may be inconsistent), which is import in `src/shared/locales/all.js`, such as

```javascript
import eleLocaleEn from 'element-ui/lib/locale/lang/en'
import eleLocaleZhCN from 'element-ui/lib/locale/lang/zh-CN'
```

### Menu & Main Interface

Motrix uses the [i18next](https://www.i18next.com/overview/getting-started) library for internationalization, so you need a quick look at how to use it.
The configuration files are divided by **locale**: `src/shared/locales`, such as `src/shared/locales/en-US` and `src/shared/locales/zh-CN`.

There are language files in the directory according to the business module.

After the menu module is refactored, the internationalization of the menu has been dispersed into the following files, and there is no need to copy the configuration in `src/main/menus`.

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
