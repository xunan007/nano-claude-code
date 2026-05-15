import { describe, expect, it } from "vitest";

import { getStartupMessage } from "../src/index.js";

describe("startup message", () => {
  it("confirms the TypeScript runtime is ready", () => {
    expect(getStartupMessage()).toBe(
      "nano-claude-code TypeScript runtime is ready.",
    );
  });
});
