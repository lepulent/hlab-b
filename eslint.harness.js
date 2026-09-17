// Reusable ESLint flat-config fragment for the quality layer.
//
// Usage in a repo's eslint.config.js:
//   import qualityHarness from './eslint.harness.js';
//   export default tseslint.config(
//     ...,
//     ...qualityHarness,
//     eslintConfigPrettier,
//   );
//
// Exports an ARRAY of flat-config objects, spread in after the base config
// (js.configs.recommended, tseslint recommended, framework plugins) and
// before eslint-config-prettier, so prettier still gets the last word on
// stylistic rules.

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // tea-enforce.cjs is a hash-pinned, byte-for-byte vendor copy (see
    // tea-hash.mjs / hookSha256 in .tea/enforce-config.json); it must never be
    // edited to satisfy house lint rules, so it is out of lint's jurisdiction
    // entirely rather than fought rule-by-rule (it is legitimate CommonJS).
    ignores: [
      '.claude/hooks/**',
      '.claude/skills/**',
      '_bmad/**',
      'canon/generated/**',
      'canon/index/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `any` defeats the type checker at the exact place types matter most;
      // force an explicit escape hatch (`unknown` + narrowing) instead.
      '@typescript-eslint/no-explicit-any': 'error',

      // Keeps `import type` separate from value imports so type-only imports
      // are always erasable and never accidentally pull in runtime code.
      '@typescript-eslint/consistent-type-imports': 'error',

      // Catches dead code and typos, while still allowing an intentionally
      // unused arg/var when it is prefixed `_` (common for ignored callback
      // params and destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `!` silences the compiler's null check instead of proving the value
      // is non-null; a wrong assertion becomes a runtime crash with no trace.
      '@typescript-eslint/no-non-null-assertion': 'error',

      // `==`/`!=` coerce types in ways that surprise readers; `===`/`!==` say
      // exactly what is being compared.
      eqeqeq: 'error',

      // `var` is function-scoped and hoists, which is a well-known source of
      // scoping bugs that `let`/`const` don't have.
      'no-var': 'error',

      // Signals intent (this binding never changes) and catches accidental
      // reassignment as an error instead of a silent bug.
      'prefer-const': 'error',

      // Left-over console noise ships to production; warn everywhere so it
      // surfaces in review, except where console output IS the point.
      'no-console': 'warn',
    },
  },
  {
    // Scripts and config files legitimately print to the console as their
    // primary output, so console use there is not a smell.
    files: ['scripts/**', '*.config.*'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // The layer itself ships Node CLI scripts (commit-msg.mjs, secret-scan.mjs)
    // into repos whose base config only declares browser globals. Without
    // this, applying the layer would hand every consumer a fresh pile of
    // `no-undef` errors on its own scripts. (.claude/hooks/** is exempted
    // above instead of patched here, since it must stay byte-identical.)
    files: ['scripts/**'],
    languageOptions: {
      globals: {
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        __filename: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
  },
];
