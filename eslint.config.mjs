import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import js from '@eslint/js';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // .claude/** 是 Claude Code 的 harness 目录（worktrees 等），不是项目源码。
    // 不排除的话，一个并发 worktree 会把整份仓库副本拖进 lint，报一堆无关错误。
    ignores: ['node_modules/**', 'dist/**', 'out/**', '.vite/**', 'docs/**', '.claude/**', 'main.js'],
  },
  js.configs.recommended,
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
