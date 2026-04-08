import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';

interface OpenClawConfig {
  gatewayUrl: string;
  token?: string;
  password?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeOpenClawMessageRecord(message: any): any {
  let current = message;
  const seen = new Set<object>();

  while (current && typeof current === 'object' && !Array.isArray(current)) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    const nested = current.message;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      break;
    }

    const currentHasRole = typeof current.role === 'string';
    const currentHasContent = current.content !== undefined;
    const nestedLooksLikeMessage = (
      typeof nested.role === 'string'
      || nested.content !== undefined
      || typeof nested.stopReason === 'string'
      || typeof nested.stop_reason === 'string'
      || nested.error !== undefined
      || nested.errorMessage !== undefined
    );

    if (!nestedLooksLikeMessage) {
      break;
    }

    if (current.type === 'message' || (!currentHasRole && !currentHasContent)) {
      current = {
        ...nested,
        timestamp: nested.timestamp ?? current.timestamp,
        createdAt: nested.createdAt ?? current.createdAt,
        created_at: nested.created_at ?? current.created_at,
      };
      continue;
    }

    break;
  }

  return current;
}

function extractContentTextParts(content: unknown, seen = new Set<object>()): string[] {
  if (!content) return [];
  if (typeof content === 'string') {
    return content.trim() ? [content] : [];
  }

  if (Array.isArray(content)) {
    return content.flatMap((item) => extractContentTextParts(item, seen));
  }

  if (typeof content !== 'object') {
    return [];
  }

  if (seen.has(content)) {
    return [];
  }
  seen.add(content);

  const record = content as Record<string, unknown>;
  const directText = [record.text, record.content].find(isNonEmptyString);
  if (directText) {
    return [directText];
  }

  if (record.message) {
    return extractContentTextParts(record.message, seen);
  }

  return [];
}

export function extractOpenClawMessageText(message: any): string {
  if (!message) return '';
  const normalizedMessage = normalizeOpenClawMessageRecord(message);

  const contentText = extractContentTextParts(normalizedMessage?.content);
  if (contentText.length > 0) {
    return contentText.join('\n');
  }

  const directText = [
    normalizedMessage?.text,
    normalizedMessage?.content,
  ].find(isNonEmptyString);

  return directText || '';
}

export function extractOpenClawMessageError(message: any): string {
  if (!message) return '';
  const normalizedMessage = normalizeOpenClawMessageRecord(message);

  const candidates = [
    normalizedMessage?.errorMessage,
    normalizedMessage?.error_message,
    normalizedMessage?.error,
    normalizedMessage?.detail,
    normalizedMessage?.reason,
    normalizedMessage?.description,
    normalizedMessage?.stderr,
    normalizedMessage?.stdout,
    normalizedMessage?.message?.errorMessage,
    normalizedMessage?.message?.error,
    normalizedMessage?.message?.detail,
    normalizedMessage?.message?.reason,
    normalizedMessage?.metadata?.errorMessage,
    normalizedMessage?.metadata?.error,
    normalizedMessage?.metadata?.detail,
    normalizedMessage?.metadata?.reason,
  ];

  for (const candidate of candidates) {
    const detail = extractErrorDetail(candidate);
    if (detail) return detail;
  }

  return '';
}

function extractChatEventText(payload: any): string {
  const messageText = extractOpenClawMessageText(payload?.message);
  if (messageText) return messageText;

  const directText = [
    payload?.text,
    payload?.delta?.text,
  ].find(isNonEmptyString);

  return directText || '';
}

function safeSerializeDetail(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === '{}' || serialized === '[]') {
      return '';
    }
    return serialized.length > 2000 ? `${serialized.slice(0, 2000)}...` : serialized;
  } catch {
    return '';
  }
}

function extractErrorDetail(value: unknown, seen = new Set<object>()): string {
  if (!value) return '';
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value instanceof Error) {
    return value.message.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const detail = extractErrorDetail(item, seen);
      if (detail) return detail;
    }
    return '';
  }
  if (typeof value !== 'object') {
    return '';
  }

  if (seen.has(value)) {
    return '';
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const preferredKeys = ['message', 'detail', 'error', 'reason', 'text', 'description', 'stderr', 'stdout'];
  for (const key of preferredKeys) {
    const detail = extractErrorDetail(record[key], seen);
    if (detail) return detail;
  }

  return safeSerializeDetail(record);
}

function extractChatEventError(payload: any, frameError?: unknown): string {
  const candidates = [
    payload?.error,
    payload?.detail,
    payload?.reason,
    payload?.message?.error,
    payload?.message?.detail,
    payload?.message?.reason,
    frameError,
    extractChatEventText(payload),
  ];

  for (const candidate of candidates) {
    const detail = extractErrorDetail(candidate);
    if (detail) return detail;
  }

  return 'Unknown stream error';
}

export class OpenClawClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: OpenClawConfig;
  private connected = false;
  private pending = new Map<string, Pending>();
  private connectPromise: Promise<void> | null = null;

  constructor(config: OpenClawConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const wsUrl = this.config.gatewayUrl.replace(/^http/, 'ws');
      const wsOptions: any = {};
      if (this.config.gatewayUrl.includes('localhost') || this.config.gatewayUrl.includes('127.0.0.1')) {
        wsOptions.headers = { Origin: this.config.gatewayUrl };
      }
      this.ws = new WebSocket(wsUrl, wsOptions);

      const fail = (err: Error) => {
        this.connected = false;
        this.connectPromise = null;
        reject(err);
      };

      this.ws.on('open', () => {
        // wait for connect.challenge event
      });

      this.ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // challenge from gateway
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            try {
              await this.request('connect', {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'openclaw-control-ui',
                  version: 'clawui-backend',
                  mode: 'webchat',
                  platform: process.platform,
                },
                caps: [],
                auth: {
                  token: this.config.token,
                  password: this.config.password,
                },
                role: 'operator',
                scopes: ['operator.admin', 'operator.write', 'operator.read'],
              });

              this.connected = true;
              this.connectPromise = null;
              this.emit('connected');
              resolve();
            } catch (err: any) {
              fail(new Error(err?.message || 'Gateway connect failed'));
            }
            return;
          }

          // response frame
          if (msg.type === 'res' && msg.id) {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);

            if (msg.ok) pending.resolve(msg.payload);
            else pending.reject(new Error(msg?.error?.message || 'Request failed'));
            return;
          }

          // Chat streaming events from gateway
          if (msg.type === 'event' && msg.event === 'chat') {
            const payload = msg.payload || msg.data;
            if (!payload) return;

            const state = payload.state; // 'delta' | 'final' | 'aborted' | 'error'
            const sessionKey = payload.sessionKey;
            const text = extractChatEventText(payload);
            const runId = payload.runId;

            if (state === 'delta') {
              this.emit('chat.delta', { sessionKey, runId, text });
            } else if (state === 'final') {
              this.emit('chat.final', { sessionKey, runId, text, message: payload.message });
            } else if (state === 'aborted') {
              this.emit('chat.aborted', { sessionKey, runId, text, message: payload.message });
            } else if (state === 'error') {
              // The gateway may send an error state if the LLM request fails dynamically
              this.emit('chat.error', { sessionKey, runId, error: extractChatEventError(payload, msg.error) });
            }
            return;
          }

        } catch (err: any) {
          this.emit('error', new Error(err?.message || 'Failed to parse message'));
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.connectPromise = null;
        this.emit('disconnected');
      });

      this.ws.on('error', (err) => {
        this.emit('error', err as Error);
        if (!this.connected) fail(err as Error);
      });
    });

    return this.connectPromise;
  }

  private async request(method: string, params?: any, timeoutMs = 60000): Promise<any> {
    if (!this.ws) throw new Error('WebSocket not initialized');

    const id = crypto.randomUUID();
    const frame = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  async call(method: string, params?: any, timeoutMs = 60000): Promise<any> {
    if (!this.connected) {
      await this.connect();
    }

    return this.request(method, params, timeoutMs);
  }

  async waitForRun(runId: string, timeoutMs = 90000): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    await this.request('agent.wait', { runId, timeoutMs }, timeoutMs + 5000);
  }

  async getLatestAssistantText(sessionKey: string, limit = 20): Promise<string> {
    const history = await this.getChatHistory(sessionKey, limit);
    return this.extractLatestAssistantText(history);
  }

  async getChatHistory(sessionKey: string, limit = 20): Promise<any> {
    if (!this.connected) {
      await this.connect();
    }

    return this.request('chat.history', {
      sessionKey,
      limit,
    }, 30000);
  }

  private extractLatestAssistantText(historyPayload: any): string {
    const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = normalizeOpenClawMessageRecord(messages[i]);
      if (m?.role !== 'assistant') continue;
      const text = extractOpenClawMessageText(m);
      if (text) return text;
    }
    return '';
  }

  // Non-blocking: sends message and returns immediately. 
  // Listen on 'chat.delta' and 'chat.final' events for the response.
  async sendChatMessageStreaming(params: {
    sessionKey: string;
    message: string;
    agentId?: string;
    attachments?: { type: string; mimeType: string; content: string }[];
  }): Promise<{ runId: string; sessionKey: string }> {
    if (!this.connected) {
      await this.connect();
    }

    const agentId = params.agentId || 'main';
    const finalSessionKey = params.sessionKey.startsWith('agent:') 
      ? params.sessionKey 
      : `agent:${agentId}:chat:${params.sessionKey}`;

    const started = await this.request('chat.send', {
      sessionKey: finalSessionKey,
      message: params.message,
      attachments: params.attachments && params.attachments.length > 0 ? params.attachments : undefined,
      idempotencyKey: crypto.randomUUID(),
    }, 30000);

    const runId = started?.runId;
    if (!runId) throw new Error('chat.send did not return runId');

    return { runId, sessionKey: finalSessionKey };
  }

  // Blocking: sends message and waits for full response (legacy)
  async sendChatMessage(params: {
    sessionKey: string;
    message: string;
    agentId?: string;
  }): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    const agentId = params.agentId || 'main';
    const finalSessionKey = params.sessionKey.startsWith('agent:') 
      ? params.sessionKey 
      : `agent:${agentId}:chat:${params.sessionKey}`;

    const started = await this.request('chat.send', {
      sessionKey: finalSessionKey,
      message: params.message,
      idempotencyKey: crypto.randomUUID(),
    }, 30000);

    const runId = started?.runId;
    if (!runId) throw new Error('chat.send did not return runId');

    await this.request('agent.wait', { runId, timeoutMs: 90000 }, 95000);

    const history = await this.request('chat.history', {
      sessionKey: finalSessionKey,
      limit: 20,
    }, 30000);

    const text = this.extractLatestAssistantText(history);
    return text || 'No assistant text found in response.';
  }

  async abortChat(params: {
    sessionKey: string;
    runId?: string;
  }): Promise<{ aborted: boolean; runIds?: string[] }> {
    if (!this.connected) {
      await this.connect();
    }

    const response = await this.request('chat.abort', {
      sessionKey: params.sessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
    }, 10000);

    return {
      aborted: response?.aborted !== false,
      runIds: Array.isArray(response?.runIds)
        ? response.runIds.filter((runId: unknown): runId is string => typeof runId === 'string')
        : undefined,
    };
  }

  async testConnection(): Promise<boolean> {
    if (!this.connected) {
      await this.connect();
    }
    return this.connected;
  }

  disconnect(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Client disconnected'));
    }
    this.pending.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }
}

export default OpenClawClient;
