# Motrix

<a href="https://motrix.app">
  <img src="https://cdn.nlark.com/yuque/0/2018/png/129147/1543735425232-a5d2c99f-d788-43e4-9781-558ff6d21027.png" width="256" alt="App Icon" />
</a>

## A full-featured download manager.
[![Build Status](https://travis-ci.org/agalwood/Motrix.svg?branch=master)](https://travis-ci.org/agalwood/Motrix) [![Build status](https://ci.appveyor.com/api/projects/status/l11d5h05xwwcvoux/branch/master?svg=true)](https://ci.appveyor.com/project/agalwood/motrix/branch/master) ![Total Downloads](https://img.shields.io/github/downloads/agalwood/Motrix/total.svg) ![Support Platforms](https://camo.githubusercontent.com/a50c47295f350646d08f2e1ccd797ceca3840e52/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f706c6174666f726d2d6d61634f5325323025374325323057696e646f77732532302537432532304c696e75782d6c69676874677265792e737667)

English | [简体中文](./README-CN.md)

Motrix is a full-featured download manager that supports downloading HTTP, FTP, BitTorrent, Magnet, Baidu Net Disk, etc.

Motrix has a clean and easy to use interface. I hope you will like it 👻.

✈️ [Official Website](https://motrix.app) | 📖 [Manual](http://motrix.app/support/issues) (zh-CN)

## 💽 Installation
Download from [GitHub Releases](https://github.com/agalwood/Motrix/releases) and install it.

Update: macOS user support `brew cask` installation, thanks to [PR](https://github.com/Homebrew/homebrew-cask/pull/59494) of [Mitscherlich](https://github.com/Mitscherlich).

```bash
brew update && brew cask install motrix
```

## ✨ Features
- 🕹 Simple and clear user interface
- 🦄 Supports BitTorrent & Magnet
- 💾 Supports downloading Baidu Net Disk
- 🎛 Up to 10 concurrent download tasks
- 🚀 Supports 64 threads in a single task
- 🕶 Mock User-Agent
- 🔔 Download completed Notification
- 💻 Ready for Touch Bar (Mac only)
- 🗑 Delete related files when removing tasks (optional)
- 🌍 I18n, [View supported languages](#-internationalization).
- 🎏 ...

## 🖥 User Interface
![motrix-screenshot-task-en.png](https://cdn.nlark.com/yuque/0/2019/png/129147/1550151166169-94b4bfb0-746e-42b8-aad7-0b6890f89abb.png)

## ⌨️ Development

### Clone Code
```bash
git clone git@github.com:agalwood/Motrix.git
```

### Install Dependencies
```bash
cd Motrix
npm install
```
If you like [Yarn](https://yarnpkg.com/), you can also use `yarn` to install dependencies.

### Dev Mode
```bash
npm run dev
```

### Build Release
```bash
npm run build
```
After building, the application will be found in the project's `release` directory.

## 🛠 Technology Stack
- [Electron](https://electronjs.org/)
- [Vue](https://vuejs.org/) + [VueX](https://vuex.vuejs.org/) + [Element](https://element.eleme.io)
- [Aria2](https://aria2.github.io/) (Note: macOS and Linux versions use 64-bit aria2c, Windows version uses 32-bit)

## ☑️ TODO
Development Roadmap see: [Trello](https://trello.com/b/qNUzA0bv/motrix)

## 🤝 Contribute [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)
If you are interested in participating in joint development, PR and Forks are welcome!

## 🌍 Internationalization
Translations into versions for other languages are welcome 🧐! Please read the [translation guide](./CONTRIBUTING.md#-translation-guide) before starting translations.

| Key   | Name            | Status       |
|-------|:----------------|:-------------|
| en-US | English         | ✔️           |
| fr    | Français        | Next Release [@gpatarin](https://github.com/gpatarin) |
| tr    | Türkçe          | Next Release [@abdullah](https://github.com/abdullah) |
| zh-CN | 简体中文         | ✔️           |
| zh-TW | 繁體中文         | Next Release [@Yukaii](https://github.com/Yukaii) |

## 📜 License
[MIT](https://opensource.org/licenses/MIT) Copyright (c) 2018-present Dr_rOot
