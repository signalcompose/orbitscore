module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 'latest',
    project: ['./tsconfig.eslint.json'],
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'eslint-config-prettier',
    'plugin:prettier/recommended',
  ],
  settings: {},
  rules: {
    'import/order': ['warn', { 'newlines-between': 'always' }],
    'no-console': 'off',
    'no-empty': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    'import/no-unresolved': 'off',
    'import/namespace': 'off',
    // `_` 接頭辞の引数は「意図的に未使用」(interface 実装で要求されるが本体が使わない等)。
    // typescript-eslint 標準慣習。通常の未使用変数の検出は維持する。
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Prettierは.prettierrc.jsonに委譲
  },
  ignorePatterns: [
    'packages/**/dist/**',
    'node_modules/**',
    'scripts/**',
    'packages/engine/vitest.config.ts',
  ],
}
