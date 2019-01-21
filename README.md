# Motrix

<a href="https://motrix.app">
  <img src="https://cdn.nlark.com/yuque/0/2018/png/129147/1543735425232-a5d2c99f-d788-43e4-9781-558ff6d21027.png" width="256" alt="App Icon" />
</a>

## A full-featured download manager.
[![Build Status](https://travis-ci.org/agalwood/Motrix.svg?branch=master)](https://travis-ci.org/agalwood/Motrix) [![Build status](https://ci.appveyor.com/api/projects/status/l11d5h05xwwcvoux/branch/master?svg=true)](https://ci.appveyor.com/project/agalwood/motrix/branch/master)

English | [简体中文](./README-CN.md)

Support downloading HTTP, FTP, BitTorrent, Magnet, Baidu Net Disk and other resources.

Hello everyone, I am an interested desktop application developer 🤓. I developed a full-featured download manager in my spare time for my hobbies. Its name is Motrix. I completed its interface design, application icons, completed most of the coding, and opened it source.

I think that its interface is beautiful, easy to operate, and rich in configuration 😌, I hope you will like it 👻.

[Official Website](https://motrix.app)

## 💽 Installation
Download from [Github Releases](https://github.com/agalwood/Motrix/releases) and install it.

## ✨ Features
- 🕹 Simple and clear user interface
- 🧲 Support BitTorrent & Magnet
- 🤫 Support downloading Baidu Net Disk
- 🎛 Up to 10 tasks concurrently download
- 🚀 Single task maximum support 64 thread download
- 🕶 Mock User-Agent
- 🔔 Download completed Notification
- 🌍 I18n, currently available Simplified Chinese & English.
- 🎏 ...

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
After build finish, you can see the compiled packaged application file in the `release` directory of the project.

## 🛠 Technology Stack
- [Electron](https://electronjs.org/)
- [Vue](https://vuejs.org/) + [VueX](https://vuex.vuejs.org/) + [Element](https://element.eleme.io)
- [Aria2](https://aria2.github.io/) (Note: macOS and Linux versions use 64-bit aria2c, Windows version uses 32-bit)

## ☑️ TODO
Development Roadmap see: [Trello](https://trello.com/b/qNUzA0bv/motrix)

## 🤝 Contribute [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)
If you are interested in participating in joint development, Fork and PR are welcome.

## 📜 License
[MIT](https://opensource.org/licenses/MIT)
Copyright (c) 2018-present Dr_rOot
