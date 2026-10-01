import typescriptEslint from "typescript-eslint";

const layers = ["common/**/*.ts", "src/**/*.ts", "webview/**/*.ts"];
const tests = ["tests/**/*.ts", "vitest.config.ts", "playwright.config.ts"];
const scripts = ["**/*.mjs"];
const linted = [...layers, ...tests, ...scripts];

// Builds the forbidden-import rules of one layer. no-restricted-imports does not look at
// dynamic import(), so every entry is emitted together with a no-restricted-syntax rule that
// carries the same message.
const forbiddenImports = (...entries) => ({
    "no-restricted-imports": ["error", {
        patterns: entries.map(({ patterns, message }) => ({ group: patterns, message })),
    }],
    "no-restricted-syntax": ["error", ...entries.map(({ dynamic, message }) => ({
        selector: `ImportExpression[source.value=${dynamic}]`,
        message,
    }))],
});

const noNodeBuiltin = (layer) => ({
    patterns: ["node:*", "node:*/**"],
    dynamic: /^node:/,
    message: `${layer} must not depend on Node.js built-in modules (node:path, node:fs and the like). `
        + "The web extension host is a Web Worker, which cannot resolve them, so the build fails. "
        + "Handle paths through URIs and file I/O through the VS Code workspace API.",
});

export default [{
    ignores: [
        "dist/**",
        "node_modules/**",
        ".vscode-test/**",
        ".vscode-test-web/**",
        "out-test/**",
        "out-test-web/**",
        "coverage/**",
        "playwright-report/**",
        "test-results/**",
    ],
}, {
    files: linted,
}, {
    files: linted,

    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, {
    files: ["common/**/*.ts"],
    rules: forbiddenImports(
        {
            patterns: ["vscode"],
            dynamic: /^vscode$/,
            message: "common must not import vscode. "
                + "The moment it depends on vscode, the webview build and tests that load common break.",
        },
        noNodeBuiltin("common"),
        {
            patterns: ["**/src/**", "**/webview/**"],
            dynamic: /\/src\/|\/webview\//,
            message: "common must not import src or webview directly. "
                + "All common may hold is the contract between the two and the environment-independent logic both of them need.",
        },
    ),
}, {
    files: ["webview/**/*.ts"],
    rules: forbiddenImports(
        {
            patterns: ["vscode"],
            dynamic: /^vscode$/,
            message: "webview must not import vscode. "
                + "As long as it does not depend on vscode, webview logic can be unit tested on jsdom.",
        },
        {
            patterns: ["**/src/**"],
            dynamic: /\/src\//,
            message: "webview must not import src directly. Code shared between them belongs in common.",
        },
    ),
}, {
    files: ["src/**/*.ts"],
    rules: forbiddenImports(
        noNodeBuiltin("src"),
        {
            patterns: ["**/webview/**"],
            dynamic: /\/webview\//,
            message: "src must not import webview directly. Code shared between them belongs in common.",
        },
    ),
}];
