# Motrix

<a href="https://motrix.app">
  <img src="https://cdn.nlark.com/yuque/0/2018/png/129147/1543735425232-a5d2c99f-d788-43e4-9781-558ff6d21027.png" width="256" alt="App Icon" />
</a>

[English](./README.md) | 简体中文

## 一款全能的下载工具
[![Build Status](https://travis-ci.org/agalwood/Motrix.svg?branch=master)](https://travis-ci.org/agalwood/Motrix) [![Build status](https://ci.appveyor.com/api/projects/status/l11d5h05xwwcvoux/branch/master?svg=true)](https://ci.appveyor.com/project/agalwood/motrix/branch/master) ![Total Downloads](https://img.shields.io/github/downloads/agalwood/Motrix/total.svg) ![Support Platforms](https://camo.githubusercontent.com/a50c47295f350646d08f2e1ccd797ceca3840e52/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f706c6174666f726d2d6d61634f5325323025374325323057696e646f77732532302537432532304c696e75782d6c69676874677265792e737667)

我是个兴趣使然的桌面应用开发者🤓，利用搬砖之余开发了 Motrix。

Motirx 是一款全能的下载工具，支持下载 HTTP、FTP、BT、磁力链、百度网盘等资源。它的界面简洁易用，希望大家喜欢 👻。

✈️ 去 [官网](https://motrix.app/zh-CN) 逛逛  |  📖 查看 [帮助手册](http://motrix.app/support/issues)

## 💽 安装稳定版
[GitHub](https://github.com/agalwood/Motrix/releases) 和 [官网](https://motrix.app/zh-CN) 提供了已经编译好的稳定版安装包，当然你也可以自己克隆代码编译打包。

> 七牛CDN流量🔥烧不起，高峰时一天烧了110G的流量💸💸💸

## ✨ 特性
- 🕹 简洁明了的图形操作界面
- 🧲 支持BT和磁力链任务
- 🤫 支持下载百度云盘资源
- 🎛 最高支持 10 个任务同时下载
- 🚀 单任务最高支持 64 线程下载
- 🕶 模拟用户代理UA
- 🔔 下载完成后通知
- 💻 支持触控栏快捷健 (Mac 专享)
- 🗑 移除任务时可同时删除相关文件
- 🌍 国际化，[查看已可选的语言](#-国际化)
- 🎏 ...

## 🖥 应用界面
![motrix-screenshot-task-cn.png](https://cdn.nlark.com/yuque/0/2019/png/129147/1550151234585-e513bd4f-e127-402f-accb-1ebbba9b3c41.png)

## ⌨️ 本地开发

### 克隆代码
```bash
git clone git@github.com:agalwood/Motrix.git
```

### 安装依赖
```bash
cd Motrix
npm install
```
天朝大陆用户建议使用淘宝的npm源
```bash
npm config set registry 'https://registry.npm.taobao.org'
export ELECTRON_MIRROR='https://npm.taobao.org/mirrors/electron/'
export SASS_BINARY_SITE='https://npm.taobao.org/mirrors/node-sass'
```
如果喜欢 [Yarn](https://yarnpkg.com/)，也可以使用 `yarn` 安装依赖

### 开发模式
```bash
npm run dev
```

### 编译打包
```bash
npm run build
```
完成之后可以在项目的 `release` 目录看到编译打包好的应用文件

## 🛠 技术栈
- [Electron](https://electronjs.org/)
- [Vue](https://vuejs.org/) + [VueX](https://vuex.vuejs.org/) + [Element](https://element.eleme.io)
- [Aria2](https://aria2.github.io/) (注：macOS 和 Linux 版本使用的是 64 位的 aria2c，Windows 版使用的 32 位的）

## ☑️ TODO
开发计划请移步 [Trello](https://trello.com/b/qNUzA0bv/motrix) 查看

## 🤝 参与共建 [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)
如果你有兴趣参与共同开发，欢迎 FORK 和 PR。

## 🌍国际化
欢迎大家将 Motrix 翻译成更多的语言版本 🧐
locale 的值请参考 Electron 的文档:
https://electronjs.org/docs/api/locales

| Key   | Name               | Status       |
|-------|:-------------------|:-------------|
| zh-CN | 🇨🇳 简体中文         | ✔️           |
| en-US | 🇺🇸 English (US)    | ✔️           |
| tr    | 🇹🇷 Türkçe          | 🏗 @abdullah |

## 📜 开源许可
基于 [MIT license](https://opensource.org/licenses/MIT) 许可进行开源。
