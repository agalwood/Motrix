//  Forked from https://github.com/samuelmeuli/mini-diary/blob/master/scripts/after-pack.js

/**
 * Source: https://github.com/patrikx3/redis-ui/blob/master/src/build/after-pack.js
 *
 * Copyright (c) 2019 Patrik Laszlo / P3X / Corifeus and contributors.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// TODO: Remove script once https://github.com/electron/electron/issues/17972 is solved by
// `electron-builder`

const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { chdir } = require('node:process')

const pkg = require('../package.json')
const binName = `${pkg.name}`.toLowerCase()

const exec = async function exec (cmd, args = []) {
  const child = spawn(cmd, args, { shell: true })
  redirectOutputFor(child)
  await waitFor(child)
}

const redirectOutputFor = child => {
  const printStdout = data => {
    process.stdout.write(data.toString())
  }
  const printStderr = data => {
    process.stderr.write(data.toString())
  }
  child.stdout.on('data', printStdout)
  child.stderr.on('data', printStderr)

  child.once('close', () => {
    child.stdout.off('data', printStdout)
    child.stderr.off('data', printStderr)
  })
}

const waitFor = async function (child) {
  return new Promise(resolve => {
    child.once('close', () => resolve())
  })
}

const linuxTargets = [
  'AppImage',
  'deb',
  'rpm',
  'snap'
]

module.exports = async function (context) {
  console.warn('after build; disable sandbox')
  const isLinux = context.targets.find(
    target => linuxTargets.includes(target)
  )
  if (!isLinux) {
    return
  }
  const originalDir = process.cwd()
  const dirname = context.appOutDir
  chdir(dirname)

  await exec('mv', [binName, binName + '.bin'])
  const wrapperScript = `#!/bin/bash
    "\${BASH_SOURCE%/*}"/${binName}.bin "$@" --no-sandbox
  `
  fs.writeFileSync(binName, wrapperScript)
  await exec('chmod', ['+x', binName])

  chdir(originalDir)
}
