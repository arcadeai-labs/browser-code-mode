# 01 · hello world

The AI SDK's `generateText` with the browser tools from `@browse-code-mode/tools/ai-sdk`.
The model reads `browser_api`, writes a TypeScript program for `browser_run`, and
answers from what the page returned.

```sh
# ANTHROPIC_API_KEY in the workspace .env
pnpm example
pnpm example 01-hello-world "What's on the front page of Hacker News?"
```

Browsers come from `providerBrowser(localProvider())`: headless local Chrome
(`CHROME_HEADLESS=0` to watch it), borrowing one already on `CHROME_PORT` if
there is one. Swap in `providerFromEnv(process.env)` for `browserbase`, `kernel`,
or `BROWSE_CDP_URL`. The example starts one
session up front; the model can start, list, watch, and stop more with the session
tools. `browser.close()` stops them all. `ANTHROPIC_MODEL` picks the model.

The whole integration is:

```ts
import { browserTools, instructions } from "@browse-code-mode/tools/ai-sdk";

await generateText({
  model,
  system: instructions,
  tools: browserTools({ browser }), // browser = providerBrowser(localProvider())
  stopWhen: stepCountIs(10),
  prompt,
});
```

For Mastra, import `browserTools` from `@browse-code-mode/tools/mastra` and pass it
to an `Agent`'s `tools`.
