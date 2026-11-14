import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// the code has many instances of these, so they report as warnings and do not fail the run
const warnings = {
    'no-unused-vars': 'warn',
    'no-useless-assignment': 'warn',
    'no-useless-escape': 'warn',
    'no-async-promise-executor': 'warn',
    'no-constant-binary-expression': 'warn',
    'no-empty': 'warn',
    'no-prototype-builtins': 'warn'
};

const typescriptWarnings = {
    '@typescript-eslint/no-unused-vars': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-expressions': 'warn',
    '@typescript-eslint/no-wrapper-object-types': 'warn',
    'prefer-const': 'warn',
    'prefer-spread': 'warn'
};

export default tseslint.config(
    {
        ignores: ['backend/public/**', 'backend/appdata/**', 'src/api-types/**']
    },
    {
        files: ['src/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            globals: globals.browser
        },
        // the typescript rule replaces the core one, which misreads constructor parameter properties
        rules: {...warnings, ...typescriptWarnings, 'no-unused-vars': 'off'}
    },
    {
        files: ['backend/**/*.js'],
        extends: [js.configs.recommended],
        languageOptions: {
            sourceType: 'commonjs',
            globals: globals.node
        },
        rules: warnings
    },
    {
        files: ['backend/test/**/*.js'],
        languageOptions: {
            globals: globals.mocha
        }
    }
);
