#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createLocalMarketplaceService } from "./local-service.mjs";
import { handleMcpMessage, parseJsonRpc } from "./protocol.mjs";

const service = createLocalMarketplaceService();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  const parsed = parseJsonRpc(line);
  const result = parsed.error || await handleMcpMessage(parsed.message, service);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}
