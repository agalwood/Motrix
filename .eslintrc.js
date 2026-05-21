module.exports = {
  root: true,
  env: {
    browser: true,
    node: true
  },
  extends: [
    'plugin:vue/essential',
    '@vue/standard'
  ],
  parserOptions: {
    parser: 'babel-eslint',
    sourceType: 'module'
  },
  globals: {
    appId: true,
    __static: true
  },
  rules: {
    'no-console': 'off',
    'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    indent: ['error', 2],
    'vue/script-indent': ['error', 2, {
      baseIndent: 1
    }]
  },
  overrides: [
    {
      files: ['*.ts'],
      parser: '@typescript-eslint/parser'
    },
    {
      files: ['*.vue'],
      rules: {
        indent: 'off'
      }
    }
  ]
}
