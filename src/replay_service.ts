import { createServer } from "node:http";
import { ZodError } from "zod";
import { InfraiClient, InfraiError } from "./infrai_client.js";
import { replayMarketplace, replayRequestSchema } from "./marketplace_replay.js";

const apiKey = process.env.INFRAI_API_KEY;
const destination = process.env.MARKETPLACE_REPLAY_URL;
if (!apiKey) throw new Error("Set INFRAI_API_KEY");
if (!destination) throw new Error("Set MARKETPLACE_REPLAY_URL");

const infrai = new InfraiClient(apiKey);

function send(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/replay") {
    send(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = replayRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result = await replayMarketplace(input, infrai, destination);
    send(response, 200, result);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      send(response, 400, { error: "Invalid replay request" });
    } else if (error instanceof InfraiError) {
      send(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.message,
        detail: error.detail,
      });
    } else {
      send(response, 502, { error: error instanceof Error ? error.message : "Replay failed" });
    }
  }
}).listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Replay service listening on http://localhost:${process.env.PORT ?? 3000}`);
});
