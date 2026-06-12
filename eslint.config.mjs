// ESLint flat config. Type-aware linting over src/ and test/; the focus is on
// correctness rules (floating promises, unused code), not formatting.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.js', '*.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['test/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.test.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        rules: {
            // Missing awaits are deploy-order bugs in this codebase.
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',

            // The AWS SDK response shapes make some `any` pragmatic; keep the
            // signal for new code without failing the existing wrappers.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',

            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],

            '@typescript-eslint/no-require-imports': 'off', // index.ts command dispatch
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            // Tests stub module shapes loosely.
            '@typescript-eslint/no-floating-promises': 'off',
        },
    },
);
