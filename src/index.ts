#!/usr/bin/env node

import { fileURLToPath } from "node:url";

export function getStartupMessage(): string {
  return "nano-claude-code TypeScript runtime is ready.";
}

function main(): void {
  console.log(getStartupMessage());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
