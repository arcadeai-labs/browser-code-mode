import { anthropic } from "@ai-sdk/anthropic";
import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  validateUIMessages,
} from "ai";
import { z } from "zod";

import { env } from "../lib/env.ts";
import { openMcpSession } from "../lib/mcp.ts";

const SYSTEM = `You drive a real web browser by writing TypeScript programs and running them with the browser_run tool.

Call browser_api once, before your first program, to learn the available commands.

Batch the steps you can already justify into one program — navigating, waiting, reading, filtering, and anything computed from a snapshot that same program just took — and return only the data you need.

Stop at the first step that depends on page content you have not seen. Never write a ref or a selector you have not observed in output; guessing one acts on the wrong element as easily as it fails. On an unfamiliar page, let the first program end at the snapshot, read what came back, then write the program that acts on it. If a target was a guess, act once and check, rather than queueing further actions behind it.

Neither extreme is right: do not call browser_run once per click, and do not write ten speculative steps at once.

The browser the user is watching is already configured, so never pass cdpUrl.

When you have the answer, reply in one or two sentences. Do not narrate the code you just ran.`;

const chatBodySchema = z.object({
  messages: z.array(z.unknown()),
  cdpUrl: z.string().optional(),
});

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!env.anthropicApiKey) {
          return Response.json(
            { error: "ANTHROPIC_API_KEY is not set on the server." },
            { status: 500 },
          );
        }

        const body = chatBodySchema.safeParse(await request.json().catch(() => null));
        if (!body.success)
          return Response.json({ error: "Invalid chat request." }, { status: 400 });
        const { cdpUrl } = body.data;
        if (!cdpUrl)
          return Response.json(
            { error: "Start a browser first." },
            { status: 400 },
          );

        let messages;
        try {
          messages = await validateUIMessages({ messages: body.data.messages });
        } catch (error) {
          return Response.json(
            { error: `Invalid chat messages: ${error instanceof Error ? error.message : String(error)}` },
            { status: 400 },
          );
        }

        let session;
        try {
          session = await openMcpSession(cdpUrl);
        } catch (error) {
          return Response.json(
            {
              error: `Could not initialize the mounted browser MCP app: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { status: 502 },
          );
        }

        try {
          const result = streamText({
            model: anthropic(env.model),
            system: [SYSTEM, session.instructions].filter(Boolean).join("\n\n"),
            messages: await convertToModelMessages(messages),
            tools: session.tools,
            abortSignal: request.signal,
            // Browser work is several programs deep: let the model act, read the
            // result, and continue without another user turn.
            stopWhen: stepCountIs(12),
            onFinish: async () => {
              await session.close().catch(() => {});
            },
            onError: async () => {
              await session.close().catch(() => {});
            },
            onAbort: async () => {
              await session.close().catch(() => {});
            },
          });

          return result.toUIMessageStreamResponse();
        } catch (error) {
          await session.close();
          throw error;
        }
      },
    },
  },
});
