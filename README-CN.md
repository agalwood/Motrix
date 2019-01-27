# Motrix

<a href="https://motrix.app">
  <img src="https://cdn.nlark.com/yuque/0/2018/png/129147/1543735425232-a5d2c99f-d788-43e4-9781-558ff6d21027.png" width="256" alt="App Icon" />
</a>

[English](./README.md) | 简体中文

## 一款全能的下载工具
[![Build Status](https://travis-ci.org/agalwood/Motrix.svg?branch=master)](https://travis-ci.org/agalwood/Motrix) [![Build status](https://ci.appveyor.com/api/projects/status/l11d5h05xwwcvoux/branch/master?svg=true)](https://ci.appveyor.com/project/agalwood/motrix/branch/master) ![Total Downloads](https://img.shields.io/github/downloads/agalwood/Motrix/total.svg) ![Support Platforms](https://camo.githubusercontent.com/a50c47295f350646d08f2e1ccd797ceca3840e52/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f706c6174666f726d2d6d61634f5325323025374325323057696e646f77732532302537432532304c696e75782d6c69676874677265792e737667)

支持下载 HTTP、FTP、BT、磁力链、百度网盘等资源

<span style="font-size: 30px">我</span>是个兴趣使然的桌面应用开发者🤓，出于兴趣爱好，利用搬砖之余开发了 [MO 1.0](https://moapp.me) 版本，做出来有大半年了，没做过什么推广，所以大家可能都没怎么听过这个应用吧～👻～

本着自己用得舒(折)服(腾)😌的想法，🤠撸出了个全新的版本，并更名为 Motrix。新版本不仅优化了性能，还重新设计了图形操作界面，操作更简便！

[官网](https://motrix.app)提供了已经编译好的应用安装包（[去官网下载](https://motrix.app/release)），当然你也可以自己克隆代码进行编译打包。

## 💽 安装稳定版
你可以 [Github Release](https://github.com/agalwood/Motrix/releases) 下载，也可以从[国内镜像](https://www.yuque.com/moapp/help/release)下载。
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
- 🌍 国际化（当前可选简体中文和美式英语）
- 🎏 ...

## 🖥 应用界面
![motrix-screenshot-task-cn.png](https://cdn.nlark.com/yuque/0/2019/png/129147/1548251088177-21762a41-3975-4417-bf54-6f64aeb0f20d.png)

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

## 📜 开源许可
基于 [MIT license](https://opensource.org/licenses/MIT) 许可进行开源。
