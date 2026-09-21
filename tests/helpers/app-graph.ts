import type { AppGraph, AppGraphOverrides } from "../../src/main/composition/app-graph.js";
import { createTestAppGraph } from "../../src/main/composition/create-test-app-graph.js";

/** Minimal production-shaped graph for IPC/handler unit tests. */
export function testAppGraph(overrides: AppGraphOverrides = {}): AppGraph {
  return createTestAppGraph(overrides);
}
