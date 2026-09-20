import js from "@eslint/js";

export default [
  // The visual companion is vendored code (D26, D69). Restyling it would mean
  // rewriting 1,400 lines kiln did not author and does not maintain.
  { ignores: ["vendor/**", "node_modules/**", "tests/fixtures/**/tmp/**", "skills/kiln-brainstorming/scripts/**"] },
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
      // ignoreRestSiblings is what makes `const { omit, ...rest } = obj` an omission
      // rather than an unused variable.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "no-param-reassign": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["tests/**/*.mjs"],
    rules: { "max-lines-per-function": "off", "max-params": "off" },
  },
];
