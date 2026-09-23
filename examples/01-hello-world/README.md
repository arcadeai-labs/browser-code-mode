# 01 · hello world

The AI SDK's `generateText` with the browser tools from `@browse-code-mode/tools/ai-sdk`.
The model reads `browser_api`, writes a TypeScript program for `browser_run`, and
answers from what the page returned.

```sh
# ANTHROPIC_API_KEY in the workspace .env
pnpm example
pnpm example 01-hello-world "What's on the front page of Hacker News?"
```

The browser comes from `openBrowser()`, which returns a `cdpUrl` and a `close()`
for whichever browser `BROWSE_PROVIDER` selects: headless local Chrome by default
(`CHROME_HEADLESS=0` to watch it), `BROWSE_CDP_URL` to borrow one, or
`browserbase` / `kernel` with that provider's credentials. `ANTHROPIC_MODEL`
picks the model.

The whole integration is:

```ts
import { browserTools, instructions } from "@browse-code-mode/tools/ai-sdk";

await generateText({
  model,
  system: instructions,
  tools: browserTools({ cdpUrl: browser.cdpUrl }), // browser = await openBrowser()
  stopWhen: stepCountIs(10),
  prompt,
});
```

For Mastra, import `browserTools` from `@browse-code-mode/tools/mastra` and pass it
to an `Agent`'s `tools`.
