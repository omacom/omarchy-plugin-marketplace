export class MarketplaceMcpError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "MarketplaceMcpError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function mcpError(code, message, context) {
  throw new MarketplaceMcpError(code, message, context);
}

export function safeError(error) {
  if (error instanceof MarketplaceMcpError) {
    return {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.context).length ? { context: error.context } : {}),
    };
  }
  return {
    code: "internal-error",
    message: "The marketplace MCP request could not be completed safely.",
  };
}
