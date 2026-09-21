// Correctness only: no stylistic rules. The formatting in this repository is deliberate
// (compact lookup tables, single-line guard clauses) and a formatter degrades it.
export default [
  // Vendored third-party code and generated output are not ours to lint.
  { ignores: ['extensions/**', 'captures/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        // These appear inside page.evaluate() and addInitScript() callbacks, which are
        // serialised and run in the browser rather than in Node.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        performance: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        chrome: 'readonly',
        PerformanceObserver: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // This one would have caught the dead MAX_PENDING_EXTRA constant.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-async-promise-executor': 'error',
      // new Promise((r) => setTimeout(r, ms)) is idiomatic here and returns a Timeout by
      // accident, not by mistake.
      'no-promise-executor-return': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
];
