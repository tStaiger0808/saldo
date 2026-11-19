import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeModel = { url: string; close(): Promise<void> };

/** The window the model list names for "mock-model", and the usage added to every answer that brings none. */
export const FAKE_CONTEXT_WINDOW = 32_000;
export const FAKE_USAGE = { prompt_tokens: 1_234, completion_tokens: 210 };

const withUsage = (answer: unknown) =>
  typeof answer === "object" && answer !== null && "choices" in answer && !("usage" in answer) ? { ...answer, usage: FAKE_USAGE } : answer;

/**
 * An OpenAI-compatible stand-in on localhost: it lists the model "mock-model" and hands every chat completion request
 * to `onCompletion`, which answers through `send` whenever it likes (at once or held back).
 */
export async function startFakeModel(
  onCompletion: (body: Record<string, unknown>, send: (answer: unknown) => void) => void,
): Promise<FakeModel> {
  const server: Server = createServer((request, response) => {
    const send = (answer: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    };
    if (request.url?.endsWith("/models")) return send({ data: [{ id: "mock-model", context_length: FAKE_CONTEXT_WINDOW }] });
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => onCompletion(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, (answer) => send(withUsage(answer))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
