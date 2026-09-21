import type { AppGraph, AppGraphOverrides } from "./app-graph.js";
import { createAppGraph } from "./app-graph.js";

export function createTestAppGraph(overrides: AppGraphOverrides = {}): AppGraph {
  return createAppGraph(overrides);
}
