import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: [
            {
                find: /^@testing-library\/react$/,
                replacement: resolve(__dirname, "./src/tests/test-library.tsx"),
            },
            { find: "@", replacement: resolve(__dirname, "./src") },
        ],
    },
    test: {
        environment: "node",
    },
});
