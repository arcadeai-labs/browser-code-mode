/**
 * Hello world: the AI SDK drives a real browser to answer one question.
 *
 *   pnpm example
 *   pnpm example 01-hello-world "Who won the last Super Bowl?"
 */

import { anthropic } from "@ai-sdk/anthropic";
import { localProvider } from "@browse-code-mode/mcp-server/local-browser";
import { browserTools, instructions } from "@browse-code-mode/tools/ai-sdk";
import { providerBrowser } from "@browse-code-mode/tools/browser";
import { generateText, stepCountIs } from "ai";

const prompt = process.argv[2] ?? "What's the weather in San Francisco right now?";

// Local Chrome: borrows one already on CHROME_PORT, or launches it.
const browser = providerBrowser(localProvider());

try {
  // Start one session up front; browser_run uses it when the model omits sessionId.
  await browser.start();

  const { text } = await generateText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5"),
    system: instructions,
    tools: browserTools({ browser }),
    // Browsing takes a few programs: read the API, look at the page, answer.
    stopWhen: stepCountIs(10),
    prompt,
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const call of toolCalls) {
        if (!call.dynamic && call.toolName === "browser_run") {
          console.log(`\n── browser_run ──\n${call.input.code}`);
        } else console.log(`\n── ${call.toolName} ──`);
      }
      for (const result of toolResults) {
        if (!result.dynamic && result.toolName === "browser_run") {
          console.log(`→ ${result.output.text.split("\n")[0]}`);
        }
      }
    },
  });

  console.log(`\n${text}`);
} finally {
  await browser.close();
}
