import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Block raw fetch() to /api/* — it skips HMAC signing in mobile mode.
      // Use apiClient from src/api/client.ts instead. Pre-auth probes in
      // AuthGate are exempt via inline disable comments.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='fetch'][arguments.0.type='Literal'][arguments.0.value=/^\\/api\\//]",
          message:
            'Use apiClient (src/api/client.ts) instead of raw fetch() so HMAC signing works in mobile mode.',
        },
        {
          selector:
            "CallExpression[callee.name='fetch'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.raw=/^\\/api\\//]",
          message:
            'Use apiClient (src/api/client.ts) instead of raw fetch() so HMAC signing works in mobile mode.',
        },
      ],
    },
  },
])
