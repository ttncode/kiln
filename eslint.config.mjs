import js from "@eslint/js";

export default [
  { ignores: ["vendor/**", "node_modules/**", "tests/fixtures/**/tmp/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: {
      "max-params": ["error", 2],
      "max-lines-per-function": ["error", { max: 20, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 3],
      complexity: ["error", 10],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      "no-unused-vars": "error",
      "no-param-reassign": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["tests/**/*.mjs"],
    rules: { "max-lines-per-function": "off", "max-params": "off" },
  },
];
