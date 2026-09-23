/**
 * Hello world: the AI SDK drives a real browser to answer one question.
 *
 *   pnpm example
 *   pnpm example 01-hello-world "Who won the last Super Bowl?"
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { browserTools, instructions } from "@browse-code-mode/tools/ai-sdk";
import { openBrowser } from "@browse-code-mode/tools/browser";

const prompt = process.argv[2] ?? "What's the weather in San Francisco right now?";

// Local Chrome by default; BROWSE_PROVIDER / BROWSE_CDP_URL pick another browser.
const browser = await openBrowser();

try {
  const { text } = await generateText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5"),
    system: instructions,
    tools: browserTools({ cdpUrl: browser.cdpUrl }),
    // Browsing takes a few programs: read the API, look at the page, answer.
    stopWhen: stepCountIs(10),
    prompt,
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const call of toolCalls) {
        if (call.toolName === "browser_run") {
          console.log(`\n── browser_run ──\n${(call.input as { code: string }).code}`);
        } else console.log(`\n── ${call.toolName} ──`);
      }
      for (const result of toolResults) {
        if (result.toolName === "browser_run") {
          console.log(`→ ${(result.output as { text: string }).text.split("\n")[0]}`);
        }
      }
    },
  });

  console.log(`\n${text}`);
} finally {
  await browser.close();
}
