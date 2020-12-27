'use strict'

process.env.BABEL_ENV = 'main'

const devMode = process.env.NODE_ENV !== 'production'
const path = require('path')
const { dependencies, build } = require('../package.json')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin');
const ESLintPlugin = require('eslint-webpack-plugin');

let mainConfig = {
  entry: {
    main: path.join(__dirname, '../src/main/index.js')
  },
  externals: [
    ...Object.keys(dependencies || {})
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        use: 'babel-loader',
        exclude: /node_modules/
      },
      {
        test: /\.node$/,
        use: 'node-loader'
      }
    ]
  },
  node: {
    __dirname: devMode,
    __filename: devMode
  },
  output: {
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    path: path.join(__dirname, '../dist/electron')
  },
  plugins: [
    new webpack.NoEmitOnErrorsPlugin(),
    new ESLintPlugin({
      formatter: require('eslint-friendly-formatter')
    })
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, '../src/main'),
      '@shared': path.join(__dirname, '../src/shared')
    },
    extensions: ['.js', '.json', '.node']
  },
  target: 'electron-main',
  optimization: {
    minimize: !devMode,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
      })
    ],
  },
}

/**
 * Adjust mainConfig for development settings
 */
if (devMode) {
  mainConfig.plugins.push(
    new webpack.DefinePlugin({
      '__static': `"${path.join(__dirname, '../static').replace(/\\/g, '\\\\')}"`,
      'appId': `"${build.appId}"`
    })
  )
}

/**
 * Adjust mainConfig for production settings
 */
if (!devMode) {
  mainConfig.plugins.push(
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': '"production"',
      'appId': `"${build.appId}"`
    })
  )
}

module.exports = mainConfig
