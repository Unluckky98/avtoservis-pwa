// Pure types shared by the assistant core. No platform imports: runs under Deno and Node (tests).

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema sent to the model; the server validates arguments again with `validate`. */
  parameters: Record<string, unknown>;
};

export type LlmRequest = { messages: ChatMessage[]; tools?: ToolSpec[]; jsonMode?: boolean };
export type LlmResponse = { content: string | null; toolCalls: ToolCall[]; totalTokens: number };

/** The only thing the core needs from a model provider. The real one wraps the OpenAI SDK. */
export interface LlmClient {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/** A tool the server can run. The model never supplies a tenant, a role or SQL — only `args`. */
export type Tool = {
  spec: ToolSpec;
  /** Throws or returns an error string for bad model-supplied arguments. */
  validate(args: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  run(value: unknown): Promise<unknown>;
};

export type Mode = 'client' | 'owner';

export class AssistantError extends Error {
  constructor(public code: 'bad_request' | 'rate_limited' | 'budget' | 'unauthorized' | 'unavailable', message: string) {
    super(message);
  }
}
