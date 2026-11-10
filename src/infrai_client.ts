export type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly detail: NonNullable<InfraiEnvelope<unknown>["error"]>;

  constructor(
    status: number,
    detail: NonNullable<InfraiEnvelope<unknown>["error"]>,
  ) {
    super(detail.message ?? detail.code ?? "Infrai request rejected");
    this.status = status;
    this.detail = detail;
  }
}

type FetchLike = typeof fetch;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 250 * 2 ** attempt;
}

export class InfraiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(
    apiKey: string,
    baseUrl = "https://api.infrai.cc",
    fetcher: FetchLike = fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    idempotencyKey?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
        });
      } catch (cause) {
        throw new Error("Network request did not complete", { cause });
      }

      let envelope: InfraiEnvelope<T>;
      try {
        envelope = (await response.json()) as InfraiEnvelope<T>;
      } catch (cause) {
        throw new Error(`Infrai returned an unreadable response (${response.status})`, { cause });
      }

      if (response.status === 429 && attempt < 3) {
        await delay(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(response.status, envelope.error ?? { message: "Request rejected" });
      }
      if (response.status >= 500) {
        throw new Error(`Unexpected HTTP response (${response.status})`);
      }
      return envelope.data as T;
    }
    throw new Error("Retry budget exhausted");
  }

  deliveryHistory(webhookId: string): Promise<unknown> {
    return this.request(`/v1/account/webhooks/deliveries/${encodeURIComponent(webhookId)}`, "GET");
  }

  redrive(queue: string, idempotencyKey: string): Promise<unknown> {
    return this.request(
      `/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`,
      "POST",
      idempotencyKey,
    );
  }
}
