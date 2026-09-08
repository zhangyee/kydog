import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import js from '@eslint/js';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // .claude/** 是 Claude Code 的 harness 目录（worktrees 等），不是项目源码。
    // 不排除的话，一个并发 worktree 会把整份仓库副本拖进 lint，报一堆无关错误。
    // .superpowers/** 同理：它是 gitignore 掉的试验/实测脚本目录（跟已经排除的
    // docs/** 里那半是一对），里面的 .mjs 跑在 Playwright 的页面上下文里、
    // 满是 document / getComputedStyle，按项目规则 lint 只会报一堆 no-undef。
    ignores: [
      'node_modules/**', 'dist/**', 'out/**', '.vite/**',
      'docs/**', '.claude/**', '.superpowers/**', 'main.js',
    ],
  },
  js.configs.recommended,
  {
    // 注入网页执行的脚本：它跑在浏览器里、不是 Node，也不是模块 ——
    // 整份源码被 ?raw 原样送进 executeJavaScriptInIsolatedWorld。
    files: ['src/main/browser/injected/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        NodeJS: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
