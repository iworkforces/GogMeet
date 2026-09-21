import { defineConfig } from "vitest/config";

/**
 * Coverage floors for bun run test:coverage.
 *
 * Global include is src TypeScript sources. Two platform-edge modules stay
 * excluded (documented exceptions — each has a dedicated suite; residual
 * branches need real EventKit / child_process timing). Track re-inclusion
 * under coverage-platform-edge.
 */
const PLATFORM_EDGE_EXCLUDES = [
  "src/main/swift/calendar-watch-sidecar.ts",
  "src/main/calendar/providers/darwin-eventkit.ts",
] as const;

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.css",
        "src/**/*.swift",
        "src/**/*.html",
        ...PLATFORM_EDGE_EXCLUDES,
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 80,
      },
    },
    projects: [
      {
        test: {
          name: "main",
          environment: "node",
          include: ["tests/main/**/*.test.ts"],
          setupFiles: ["./tests/setup.main.ts"],
          coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            include: ["src/main/**/*.ts"],
            exclude: ["src/main/**/*.d.ts", "src/main/**/*.swift", ...PLATFORM_EDGE_EXCLUDES],
            thresholds: {
              lines: 90,
              statements: 90,
              functions: 90,
              branches: 80,
            },
          },
        },
      },
      {
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["tests/renderer/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
          coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            include: ["src/renderer/**/*.ts"],
            exclude: ["src/renderer/**/*.d.ts", "src/renderer/**/*.css"],
            // Soft floors: prevent silent collapse without requiring full UI path parity.
            thresholds: {
              lines: 70,
              statements: 70,
              functions: 70,
              branches: 50,
            },
          },
        },
      },
      {
        test: {
          name: "vertical",
          environment: "jsdom",
          include: ["tests/vertical/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
        },
      },
      {
        test: {
          name: "application",
          environment: "node",
          include: ["tests/application/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
          coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            include: ["src/main/application/**/*.ts"],
            exclude: ["src/main/application/**/*.d.ts"],
            thresholds: {
              lines: 80,
              statements: 80,
              functions: 80,
              branches: 70,
            },
          },
        },
      },
      {
        test: {
          name: "domain",
          environment: "node",
          include: ["tests/domain/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
          coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            include: ["src/domain/**/*.ts"],
            exclude: ["src/domain/**/*.d.ts"],
            thresholds: {
              lines: 90,
              statements: 90,
              functions: 90,
              branches: 80,
            },
          },
        },
      },
      {
        test: {
          name: "shared",
          environment: "node",
          include: ["tests/shared/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
          coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            include: ["src/shared/**/*.ts"],
            exclude: [
              "src/shared/**/*.d.ts",
              // Type-only modules (no executable statements).
              "src/shared/alert.ts",
              "src/shared/app-state.ts",
            ],
            thresholds: {
              lines: 90,
              statements: 90,
              functions: 80,
              branches: 80,
            },
          },
        },
      },
      {
        test: {
          name: "scripts",
          environment: "node",
          include: ["tests/scripts/**/*.test.ts"],
          setupFiles: ["./tests/setup.as.ts"],
        },
      },
    ],
  },
});
