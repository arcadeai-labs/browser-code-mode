/** Server-side configuration. */
export const env = {
  mcpAuthToken: process.env.MCP_AUTH_TOKEN,
  /** CDP endpoint the agent drives, and that the left pane mirrors. */
  cdpUrl: process.env.BROWSE_CDP_URL ?? "9222",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
};

export function mcpHeaders(): Record<string, string> {
  return env.mcpAuthToken ? { authorization: `Bearer ${env.mcpAuthToken}` } : {};
}
