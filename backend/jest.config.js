module.exports = {
    testEnvironment: "node",
    testMatch: ["**/tests/**/*.test.js"],
    setupFiles: ["./tests/setEnv.js"],
    // Disable Babel transform — pure CommonJS, Node.js native require is sufficient.
    // This also avoids Babel choking on top-level `return` in config/redis.js.
    transform: {},
    moduleNameMapper: {
        "^ioredis$": "<rootDir>/__mocks__/ioredis.js",
    },
    testTimeout: 30000,
    verbose: true,
};
