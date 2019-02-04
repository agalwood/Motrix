# Motrix

<a href="https://motrix.app">
  <img src="https://cdn.nlark.com/yuque/0/2018/png/129147/1543735425232-a5d2c99f-d788-43e4-9781-558ff6d21027.png" width="256" alt="App Icon" />
</a>

## 一款全能的下载工具
[![Build Status](https://travis-ci.org/agalwood/Motrix.svg?branch=master)](https://travis-ci.org/agalwood/Motrix) [![Build status](https://ci.appveyor.com/api/projects/status/l11d5h05xwwcvoux/branch/master?svg=true)](https://ci.appveyor.com/project/agalwood/motrix/branch/master)


支持下载 HTTP、FTP、BT、磁力链、百度网盘等资源

<span style="font-size: 30px">我</span>是个兴趣使然的桌面应用开发者🤓，出于兴趣爱好，利用搬砖之余开发了 [MO 1.0](https://moapp.me) 版本，做出来有大半年了，没做过什么推广，所以大家可能都没怎么听过这个应用吧～👻～

本着自己用得舒(折)服(腾)😌的想法，🤠撸出了个全新的版本，并更名为 Motrix。新版本不仅优化了性能，还重新设计了图形操作界面，操作更简便！

[官网](https://motrix.app)提供了已经编译好的应用安装包（[去官网下载](https://motrix.app/release)），当然你也可以自己克隆代码进行编译打包。

## 🛠 技术栈
- [Electron](https://electronjs.org/)
- [Vue](https://vuejs.org/) + [VueX](https://vuex.vuejs.org/) + [Element](https://element.eleme.io)
- [Aria2](https://aria2.github.io/) (注：macOS 和 Linux 版本使用的是 64 位的 aria2c，Windows 版使用的 32 位的）

## 📦 自行编译

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
完成之后可以在项目的 release 目录看到编译打包好的应用文件

## ☑️ TODO
开发计划请移步 [Trello](https://trello.com/b/qNUzA0bv/motrix)

## 🤝 参与共建 [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com) [![Join the chat at https://gitter.im/motrix-community/community](https://badges.gitter.im/motrix-community/community.svg)](https://gitter.im/motrix-community/community?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)
如果你有兴趣参与共同开发，欢迎 FORK 和 PR。

## 📜 开源许可
基于 [MIT license](https://opensource.org/licenses/MIT) 许可进行开源。
