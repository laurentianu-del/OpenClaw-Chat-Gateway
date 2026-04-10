import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type DB from './db';
import type { GroupMemberRow, GroupMessageRow } from './db';
import { extractOpenClawMessageText, type OpenClawClient } from './openclaw-client';
import {
  type ChatHistorySnapshot,
  extractSettledAssistantOutcome,
  getHistorySnapshot,
  shouldPreferSettledAssistantText,
} from './chat-history-reconciliation';
import { EventEmitter } from 'events';
import {
  AudioPreparationError,
  buildAudioTranscriptContext,
  prepareAudioTranscriptsFromUploads,
} from './audio-transcription';
import {
  rewriteMessageWithWorkspaceUploads,
  type MessageAttachment,
  type WorkspaceUploadLink,
} from './message-upload-rewrite';
import { rewriteVisibleFileLinks } from './file-link-rewrite';
import { getGroupRuntimeSessionKey } from './group-workspace';
import { selectPreferredTextSnapshot } from './text-snapshot-protection';

const DEFAULT_MAX_CHAIN_DEPTH = 6;
const GROUP_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const GROUP_STREAM_COMPLETION_PROBE_DELAY_MS = 1200;
const GROUP_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
const GROUP_HISTORY_COMPLETION_PROBE_LIMIT = 60;
const GROUP_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
const GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
const GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
const MAX_CHAIN_DEPTH_MESSAGE_CODE = 'group.maxChainDepthReached' as const;
const MAX_CHAIN_DEPTH_MESSAGE_REGEX = /^链式转发已达到最大深度 \((\d+) 轮\)$/;
const AGENT_RESPONSE_FAILED_MESSAGE_CODE = 'group.agentResponseFailed' as const;
const AGENT_RESPONSE_FAILED_MESSAGE_REGEX = /^❌\s+(.+?)\s+响应失败:\s*([\s\S]*)$/;
const GROUP_HOST_TAKEOVER_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const GROUP_HOST_TAKEOVER_HOST_ROOT_PATH = path.join(os.homedir(), '.openclaw', 'host-takeover', 'bin', 'host-root');

export interface StructuredGroupMessage {
  messageCode?: string;
  messageParams?: Record<string, string | number | boolean | null>;
  rawDetail?: string;
  forceSystemMessage?: boolean;
}

type ActiveGroupRun = {
  groupId: string;
  agentId: string;
  agentName: string;
  runId: string;
  sessionKey: string;
  client: OpenClawClient;
  startedAt: number;
  messageId: number;
  parentId?: number;
  modelUsed: string;
  createdAt: string;
  text: string;
};

type PendingGroupRun = {
  groupId: string;
  agentId: string | null;
  agentName: string | null;
  startedAt: number;
  messageId?: number;
  parentId?: number;
  modelUsed?: string;
  createdAt?: string;
  text: string;
};

function resolveChatFinalTextSnapshot(text: string, message: any): string {
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

function isGroupHostTakeoverEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(GROUP_HOST_TAKEOVER_CONFIG_PATH, 'utf-8'));
    return !config?.tools?.profile && config?.tools?.exec?.security === 'full';
  } catch {
    return false;
  }
}

function buildGroupHostTakeoverPrompt(): string {
  const currentUser = (process.env.USER || 'user').trim() || 'user';
  return [
    '【Host takeover】',
    'Maximum permissions are enabled. You can directly operate this Linux host and use root when required.',
    'Treat installed host tools as part of your execution environment: if a command-line tool exists on this machine, you should discover it from PATH and use it directly instead of claiming the product lacks that capability.',
    'For uploaded files or workspace files, use their absolute paths. When the model cannot natively understand a file type, first call the appropriate local tool to inspect, transcribe, convert, extract, or summarize it, then continue the task.',
    `Immediate root entrypoint: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH}`,
    `Run a complex root shell with: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH} /bin/sh -lc '<command>'`,
    `To drop back to the normal user, run: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH} --as-user ${currentUser} -- <command>`,
    'After the OpenClaw gateway restarts, common commands such as sudo, apt, apt-get, pip, python -m pip, systemctl, journalctl, mount, umount, chmod, chown, and tee will also flow through the takeover wrappers automatically.',
  ].join('\n');
}

function createMaxChainDepthMessage(maxDepth: number): Required<StructuredGroupMessage> & { content: string } {
  return {
    content: `链式转发已达到最大深度 (${maxDepth} 轮)`,
    messageCode: MAX_CHAIN_DEPTH_MESSAGE_CODE,
    messageParams: { maxDepth },
    rawDetail: '',
    forceSystemMessage: true,
  };
}

export function createAgentResponseFailedMessage(agentName: string, rawDetail?: string | null): Required<StructuredGroupMessage> & { content: string } {
  const detail = (rawDetail || '').trim();
  return {
    content: `❌ ${agentName} 响应失败: ${detail || 'Unknown error'}`,
    messageCode: AGENT_RESPONSE_FAILED_MESSAGE_CODE,
    messageParams: { agentName },
    rawDetail: detail,
    forceSystemMessage: true,
  };
}

export function getStructuredGroupMessage(content?: string | null): StructuredGroupMessage {
  if (!content) return {};

  const maxDepthMatch = content.match(MAX_CHAIN_DEPTH_MESSAGE_REGEX);
  if (maxDepthMatch) {
    const maxDepth = Number(maxDepthMatch[1]);
    if (Number.isFinite(maxDepth)) {
      return {
        messageCode: MAX_CHAIN_DEPTH_MESSAGE_CODE,
        messageParams: { maxDepth },
        rawDetail: '',
        forceSystemMessage: true,
      };
    }
  }

  const agentResponseFailedMatch = content.match(AGENT_RESPONSE_FAILED_MESSAGE_REGEX);
  if (agentResponseFailedMatch) {
    const agentName = agentResponseFailedMatch[1]?.trim();
    const rawDetail = agentResponseFailedMatch[2]?.trim() || '';
    if (agentName) {
      return {
        messageCode: AGENT_RESPONSE_FAILED_MESSAGE_CODE,
        messageParams: { agentName },
        rawDetail,
        forceSystemMessage: true,
      };
    }
  }

  return {};
}

/**
 * GroupChatEngine handles message routing in group chats.
 * 
 * Improvements inspired by OpenCrew:
 * - Structured agent prompts (Objective / Context / Boundaries)
 * - WAIT discipline: agents do one step then wait
 * - Better anti-loop: per-group maxTurns + self-mention prevention
 */
export class GroupChatEngine extends EventEmitter {
  private db: DB;
  private getClient: (sessionId: string) => Promise<OpenClawClient>;
  private getAgentModel: (agentId: string) => string;
  private processingGroups = new Set<string>();
  private prepareGroupRuntime: (groupId: string, agentId: string) => Promise<{
      runtimeAgentId: string;
      workspacePath: string;
      uploadsPath: string;
      outputPath: string;
  }>;
  private pendingRuns = new Map<string, PendingGroupRun>();
  private activeRuns = new Map<string, ActiveGroupRun>();

  constructor(
    db: DB,
    getClient: (sessionId: string) => Promise<OpenClawClient>,
    getAgentModel: (agentId: string) => string,
    prepareGroupRuntime: (groupId: string, agentId: string) => Promise<{
      runtimeAgentId: string;
      workspacePath: string;
      uploadsPath: string;
      outputPath: string;
    }>
  ) {
    super();
    this.db = db;
    this.getClient = getClient;
    this.getAgentModel = getAgentModel;
    this.prepareGroupRuntime = prepareGroupRuntime;
  }

  private emitRunState(groupId: string) {
    const activeRun = this.activeRuns.get(groupId);
    const pendingRun = this.pendingRuns.get(groupId);
    const currentRun = activeRun || pendingRun;
    this.emit('run_state', {
      groupId,
      active: this.processingGroups.has(groupId) || !!currentRun,
      agentId: currentRun?.agentId || null,
      runId: activeRun?.runId || null,
      startedAt: currentRun?.startedAt || null,
    });
  }

  private setPendingRun(pendingRun: PendingGroupRun) {
    this.pendingRuns.set(pendingRun.groupId, pendingRun);
    this.emitRunState(pendingRun.groupId);
  }

  private clearPendingRun(groupId: string, messageId?: number) {
    const current = this.pendingRuns.get(groupId);
    if (!current) return;
    if (typeof messageId === 'number' && current.messageId !== messageId) return;
    this.pendingRuns.delete(groupId);
    this.emitRunState(groupId);
  }

  private setActiveRun(activeRun: ActiveGroupRun) {
    this.pendingRuns.delete(activeRun.groupId);
    this.activeRuns.set(activeRun.groupId, activeRun);
    this.emitRunState(activeRun.groupId);
  }

  private updateActiveRunText(groupId: string, runId: string, text: string) {
    const activeRun = this.activeRuns.get(groupId);
    if (!activeRun || activeRun.runId !== runId) return;
    activeRun.text = selectPreferredTextSnapshot(activeRun.text, text);
  }

  private clearActiveRun(groupId: string, runId?: string) {
    const current = this.activeRuns.get(groupId);
    if (!current) return;
    if (runId && current.runId !== runId) return;
    this.activeRuns.delete(groupId);
    this.emitRunState(groupId);
  }

  getGroupRunState(groupId: string) {
    const activeRun = this.activeRuns.get(groupId);
    const pendingRun = this.pendingRuns.get(groupId);
    const currentRun = activeRun || pendingRun;
    return {
      groupId,
      active: this.processingGroups.has(groupId) || !!currentRun,
      agentId: currentRun?.agentId || null,
      runId: activeRun?.runId || null,
      startedAt: currentRun?.startedAt || null,
    };
  }

  isGroupProcessing(groupId: string) {
    return this.processingGroups.has(groupId) || this.pendingRuns.has(groupId) || this.activeRuns.has(groupId);
  }

  getGroupActiveRunMessage(groupId: string) {
    const currentRun = this.activeRuns.get(groupId) || this.pendingRuns.get(groupId);
    if (!currentRun || typeof currentRun.messageId !== 'number') {
      return null;
    }

    return {
      groupId,
      id: currentRun.messageId,
      parent_id: currentRun.parentId ?? null,
      sender_type: 'agent',
      sender_id: currentRun.agentId,
      sender_name: currentRun.agentName,
      content: currentRun.text,
      model_used: currentRun.modelUsed,
      created_at: currentRun.createdAt || new Date(currentRun.startedAt).toISOString(),
    };
  }

  async abortGroupRun(groupId: string): Promise<{ aborted: boolean }> {
    const activeRun = this.activeRuns.get(groupId);
    if (!activeRun) {
      return { aborted: false };
    }

    try {
      const result = await activeRun.client.abortChat({
        sessionKey: activeRun.sessionKey,
        runId: activeRun.runId,
      });
      this.clearActiveRun(groupId, activeRun.runId);
      this.emit('typing_done', { groupId, agentId: activeRun.agentId });
      return { aborted: result.aborted };
    } catch (error) {
      console.error(`[GroupChatEngine] Failed to abort run for group ${groupId}:`, error);
      throw error;
    }
  }

  private resolveMemberDisplayName(member: GroupMemberRow): string {
    const linkedSession = this.db.getSessionByAgentId(member.agent_id) || this.db.getSession(member.agent_id);
    const latestName = linkedSession?.name?.trim();
    return latestName || member.display_name;
  }

  private resolveMembers(members: GroupMemberRow[]): GroupMemberRow[] {
    return members.map((member) => {
      const latestName = this.resolveMemberDisplayName(member);
      return latestName === member.display_name ? member : { ...member, display_name: latestName };
    });
  }

  private resolveGroupParentId(groupId: string, _requestedParentId?: number): number | undefined {
    // Group chats are strictly linear. Always attach new messages to the latest
    // persisted group message instead of honoring any older valid parent id.
    return this.db.getLatestGroupMessageId(groupId);
  }

  /**
   * Parse @mentions from message content.
   * Returns array of matching member agentIds.
   */
  parseMentions(content: string, members: GroupMemberRow[]): string[] {
    const mentioned: string[] = [];
    
    // Check for @all
    if (/@all\b/i.test(content)) {
      return members.map(m => m.agent_id);
    }

    for (const member of members) {
      // Match @displayName (e.g. @产品经理, @程序员)
      const escaped = member.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`@${escaped}(?:\\s|$|[，。！？,.]|$)`, 'i');
      if (regex.test(content)) {
        mentioned.push(member.agent_id);
      }
    }

    return [...new Set(mentioned)];
  }

  /**
   * Build a structured prompt for an agent (inspired by OpenCrew's Subagent Packet).
   * Includes: role identity, group context, recent messages, task, and boundaries.
   */
  buildAgentPrompt(
    groupName: string,
    groupDesc: string,
    member: GroupMemberRow,
    allMembers: GroupMemberRow[],
    recentMessages: GroupMessageRow[], 
    triggerMsg: string,
    triggerSenderName: string,
    processStartTag?: string,
    processEndTag?: string,
    workspacePath?: string,
    uploadsPath?: string,
    outputPath?: string,
    remainingDepth: number = 0
  ): string {
    // Build recent message context (last 15 messages, truncated)
    const contextLines = recentMessages.map(m => {
      const name = m.sender_type === 'user' ? '用户' : (m.sender_name || '未知');
      const normalizedContent = uploadsPath
        ? rewriteMessageWithWorkspaceUploads(m.content, uploadsPath, { extractImageAttachments: false }).text
        : m.content;
      const truncated = normalizedContent.length > 500 ? normalizedContent.slice(0, 500) + '...(已截断)' : normalizedContent;
      return `[${name}]: ${truncated}`;
    }).join('\n');

    // Build the dynamic contextual prompt
    // Format instructions FIRST for maximum priority
    const parts: string[] = [];
    const hasProcessTags = !!(processStartTag && processEndTag);

    // 0. FORMAT INSTRUCTIONS (FIRST - highest priority)
    let formatHeader = `=== 系统强制规定（最高优先级，必须遵守）===\n`;
    let ruleIdx = 1;

    if (hasProcessTags) {
      formatHeader += `规则${ruleIdx++}: 【工作记录汇报】在回复中，用以下标签包裹你的实际执行步骤、操作记录和中间结果（就像团队成员汇报工作进度一样）：\n${processStartTag}\n（在这里写你做了什么、执行了哪些操作、看到了什么结果）\n${processEndTag}\n标签外面写最终结论或给人的回复。这是团队协作的标准汇报格式，必须遵守！\n`;
    }

    if (remainingDepth === 0) {
      formatHeader += `规则${ruleIdx++}: 【禁止@他人】严禁在回复中出现 "@任何人" 的内容。必须独立完成任务，直接给出结论。\n`;
    } else {
      const otherMembers = allMembers.filter(m => m.agent_id !== member.agent_id).map(m => m.display_name);
      if (otherMembers.length > 0) {
        formatHeader += `规则${ruleIdx++}: 【可选转交】若需他人继续处理，可在回复末尾加 "@姓名"（可用: ${otherMembers.join(', ')}）。若已完成则不加。\n`;
      }
    }

    formatHeader += `=== 规定结束 ===`;
    parts.push(formatHeader);

    // 1. Group-level system prompt
    if (groupDesc && groupDesc.trim() !== '') {
      parts.push(groupDesc);
    }

    if (isGroupHostTakeoverEnabled()) {
      parts.push(buildGroupHostTakeoverPrompt());
    }

    if (workspacePath && uploadsPath && outputPath) {
      parts.push(
        `团队工作区:\n`
        + `- 根目录: ${workspacePath}\n`
        + `- 上传目录: ${uploadsPath}\n`
        + `- 输出目录: ${outputPath}\n`
        + `- 新生成的项目目录请创建在团队工作区根目录下，不要写入成员个人 workspace。`
      );
    }
    
    // 2. Member-level role
    if (member.role_description && member.role_description.trim() !== '') {
      parts.push(`当前身份: ${member.display_name}\n${member.role_description}`);
    } else {
      parts.push(`当前身份: ${member.display_name}`);
    }

    // 3. Chat context
    if (contextLines) {
      parts.push(`团队对话历史:\n${contextLines}`);
    }

    // 4. Trigger message
    parts.push(`最新任务 (${triggerSenderName}):\n${triggerMsg}`);

    // 5. End reminder
    if (hasProcessTags) {
      parts.push(`[汇报格式提醒] 请用 ${processStartTag}...${processEndTag} 记录你的操作步骤和执行结果，再在标签外写对话结论。就像施工日志一样，记录你实际做了什么。`);
    }

    const finalPrompt = parts.join('\n\n');
    console.log(`[GroupChat][Prompt] agent=${member.display_name} hasProcessTags=${hasProcessTags} depth=${remainingDepth}\n${finalPrompt.slice(0, 600)}`);
    return finalPrompt;
  }

  /**
   * Send a user message to the group chat, route to agents.
   */
  async sendUserMessage(groupId: string, content: string, specifiedParentId?: number): Promise<void> {
    if (this.processingGroups.has(groupId)) {
      const error = new Error('Group run already in progress.');
      (error as Error & { code?: string }).code = 'GROUP_RUN_IN_PROGRESS';
      throw error;
    }

    this.processingGroups.add(groupId);
    this.emitRunState(groupId);

    try {
      const group = this.db.getGroupChat(groupId);
      if (!group) throw new Error('团队不存在');

      const members = this.resolveMembers(this.db.getGroupMembers(groupId));
      if (members.length === 0) throw new Error('团队没有成员');

      // Always keep group chats linear: if the requested parent is stale, fall back to the latest existing message.
      const computedParentId = this.resolveGroupParentId(groupId, specifiedParentId);

      // Save user message
      const userMsgId = this.db.saveGroupMessage({
        group_id: groupId,
        parent_id: computedParentId,
        sender_type: 'user',
        sender_name: '用户',
        content,
      });

      this.emit('message', { groupId, id: userMsgId, parent_id: computedParentId, sender_type: 'user', sender_name: '用户', content, created_at: new Date().toISOString() });

      // Parse mentions
      let targetAgentIds = this.parseMentions(content, members);
      
      // Special handling for /new command
      if (content.trim() === '/new') {
        // Send the clear command to ALL agents in the group
        targetAgentIds = members.map(m => m.agent_id);
        
        // We don't want them pinging each other back in response to a reset
        // We can just rely on normal dispatching
      }
      // No mention → send to first member (group lead) or last replying agent (exclude system)
      else if (targetAgentIds.length === 0) {
        const recent = this.db.getRecentGroupMessages(groupId, 5);
        const lastAgent = [...recent].reverse().find(m => m.sender_type === 'agent' && m.sender_id !== 'system');
        if (lastAgent?.sender_id) {
          targetAgentIds = [lastAgent.sender_id];
        } else {
          targetAgentIds = [members[0].agent_id];
        }
      }

      // Send to each targeted agent sequentially so group history stays linear.
      let currentParentId: number | undefined = userMsgId;
      for (const agentId of targetAgentIds) {
        const res = await this.sendToAgent(groupId, group.name, agentId, content, '用户', 0, currentParentId);
        if (res !== undefined) currentParentId = res;
      }
    } finally {
      this.processingGroups.delete(groupId);
      this.emitRunState(groupId);
    }
  }

  /**
   * Send a message to a specific agent and handle chain forwarding.
   * Anti-loop protection:
   *   1. Max chain depth (default 6, configurable per group)
   *   2. No self-mention forwarding
   *   3. Relaxed A->B->A to allow iterative multi-agent tasks (like Coder<=>Tester loops)
   */
  public async sendToAgent(
    groupId: string,
    groupName: string,
    agentId: string,
    triggerMsg: string,
    triggerSenderName: string,
    depth: number,
    parentId?: number
  ): Promise<number | undefined> {

    // Keep the agent reply chain attached to the latest valid message even if the incoming parent is stale.
    parentId = this.resolveGroupParentId(groupId, parentId);

    const group = this.db.getGroupChat(groupId);
    const maxDepth = group?.max_chain_depth ?? DEFAULT_MAX_CHAIN_DEPTH;

    if (maxDepth === 0 && depth > 0) {
      // 链式转发设为 0 时禁止自动转发
      return parentId;
    }

    if (maxDepth > 0 && depth >= maxDepth) {
      const { content: warnMsg, messageCode, messageParams } = createMaxChainDepthMessage(maxDepth);
      const warnId = this.db.saveGroupMessage({
        group_id: groupId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: 'system',
        sender_name: '系统',
        content: warnMsg,
      });
      this.emit('message', {
        groupId,
        id: warnId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: 'system',
        sender_name: '系统',
        content: warnMsg,
        messageCode,
        messageParams,
        created_at: new Date().toISOString(),
      });
      return warnId;
    }

    const members = this.resolveMembers(this.db.getGroupMembers(groupId));
    const member = members.find(m => m.agent_id === agentId);
    if (!member) return parentId;

    // Emit typing indicator
    this.emit('typing', { groupId, agentId, displayName: member.display_name });
    let msgId: number | undefined;
    let activeRunId: string | null = null;
    let typingFinished = false;
    const placeholderCreatedAt = new Date().toISOString();
    const modelUsed = this.getAgentModel(agentId);

    const finishTyping = () => {
      if (typingFinished) return;
      typingFinished = true;
      this.emit('typing_done', { groupId, agentId });
    };

    try {
      msgId = this.db.saveGroupMessage({
        group_id: groupId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: agentId,
        sender_name: member.display_name,
        content: '',
        model_used: modelUsed,
        created_at: placeholderCreatedAt,
      });

      this.emit('message', {
        groupId,
        id: msgId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: agentId,
        sender_name: member.display_name,
        content: '',
        model_used: modelUsed,
        created_at: placeholderCreatedAt
      });
      this.setPendingRun({
        groupId,
        agentId,
        agentName: member.display_name,
        startedAt: Date.now(),
        messageId: msgId,
        parentId,
        modelUsed,
        createdAt: placeholderCreatedAt,
        text: '',
      });

      const group = this.db.getGroupChat(groupId);
      const groupSysPrompt = group?.system_prompt || group?.description || '';
      const runtimeContext = await this.prepareGroupRuntime(groupId, agentId);
      
      // Token Optimization: OpenClaw gateway natively remembers history for 'sessionKey'.
      // If we send the last 20 messages every turn, token usage explodes exponentially O(N^2).
      // Solution: Only send messages that occurred SINCE this agent last spoke.
      const allRecent = this.db.getGroupMessages(groupId, 100); 
      let lastSpokeIdx = -1;
      for (let i = allRecent.length - 1; i >= 0; i--) {
        if (allRecent[i].sender_type === 'agent' && allRecent[i].sender_id === agentId) {
          lastSpokeIdx = i;
          break;
        }
      }
      
      let deltaMessages = [];
      if (lastSpokeIdx === -1) {
        // First time speaking in recent history, give initial context
        deltaMessages = allRecent.slice(-15);
      } else {
        // Only include messages after the agent's last reply
        deltaMessages = allRecent.slice(lastSpokeIdx + 1);
        if (deltaMessages.length > 20) deltaMessages = deltaMessages.slice(-20);
      }
      
      const isResetCommand = triggerMsg.trim() === '/new';
      const remainingDepth = maxDepth === 0 ? 0 : Math.max(0, maxDepth - depth);
      const memberSessionConfig = this.db.getSessionByAgentId(agentId);
      const processStartTag = group?.process_start_tag || memberSessionConfig?.process_start_tag;
      const processEndTag = group?.process_end_tag || memberSessionConfig?.process_end_tag;
      const rewrittenTrigger = isResetCommand
        ? { text: triggerMsg, attachments: [] as MessageAttachment[], linkedUploads: [] as WorkspaceUploadLink[] }
        : rewriteMessageWithWorkspaceUploads(triggerMsg, runtimeContext.uploadsPath, { extractImageAttachments: true });
      const audioTranscriptContext = isResetCommand
        ? ''
        : buildAudioTranscriptContext(
          await prepareAudioTranscriptsFromUploads(rewrittenTrigger.linkedUploads, runtimeContext.runtimeAgentId)
        );
      const promptInput = [rewrittenTrigger.text, audioTranscriptContext].filter(Boolean).join('\n\n').trim();

      const prompt = isResetCommand 
        ? triggerMsg
        : this.buildAgentPrompt(
          groupName,
          groupSysPrompt,
          member,
          members,
          deltaMessages,
          promptInput,
          triggerSenderName,
          processStartTag,
          processEndTag,
          runtimeContext.workspacePath,
          runtimeContext.uploadsPath,
          runtimeContext.outputPath,
          remainingDepth
        );

      // Use the group's ID as the session key so it isolates memory per group
      // Tools (browser, code execution, etc.) are granted via agentId, not sessionKey.
      const sessionKey = getGroupRuntimeSessionKey(groupId);
      const client = await this.getClient(runtimeContext.runtimeAgentId);
      const expectedSessionKey = sessionKey.startsWith('agent:')
        ? sessionKey
        : `agent:${runtimeContext.runtimeAgentId}:chat:${sessionKey}`;
      const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, GROUP_HISTORY_COMPLETION_PROBE_LIMIT)
        .then((history) => getHistorySnapshot(history))
        .catch(() => ({ length: 0, latestSignature: '' }));

      // Start streaming response
      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey,
        message: prompt,
        agentId: runtimeContext.runtimeAgentId,
        attachments: rewrittenTrigger.attachments,
      });
      activeRunId = runId;
      this.setActiveRun({
        groupId,
        agentId,
        agentName: member.display_name,
        runId,
        sessionKey: finalSessionKey,
        client,
        startedAt: Date.now(),
        messageId: msgId,
        parentId: parentId,
        modelUsed,
        createdAt: placeholderCreatedAt,
        text: '',
      });

      // Listen for stream events
      let visibleFinalOutput = '';
      let finalOutput = '';
      let finalEventText = '';
      const response = await new Promise<string>((resolve, reject) => {
        let idleTimeout: NodeJS.Timeout | null = null;
        let completionProbeTimer: NodeJS.Timeout | null = null;
        let completionProbeInFlight = false;
        let completionProbePending = false;
        let settled = false;
        let firstCompletionWaitResolvedAt: number | null = null;
        let finalEventGeneration = 0;
        let settledCalibrationGeneration = 0;

        const clearIdleTimeout = () => {
          if (idleTimeout) {
            clearTimeout(idleTimeout);
            idleTimeout = null;
          }
        };

        const clearCompletionProbeTimer = () => {
          if (completionProbeTimer) {
            clearTimeout(completionProbeTimer);
            completionProbeTimer = null;
          }
        };

        const cleanup = () => {
          clearIdleTimeout();
          clearCompletionProbeTimer();
          client.off('chat.delta', onDelta);
          client.off('chat.final', onFinal);
          client.off('chat.error', onError);
          client.off('chat.aborted', onAborted);
          client.off('disconnected', onDisconnect);
        };

        const resolveOnce = (value: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const resetIdleTimeout = () => {
          clearIdleTimeout();
          idleTimeout = setTimeout(() => {
            rejectOnce(new Error(finalOutput.trim() ? 'Stream interrupted (idle timeout).' : 'Stream timed out (no response).'));
          }, GROUP_STREAM_IDLE_TIMEOUT_MS);
        };

        const scheduleCompletionProbe = (delay = GROUP_STREAM_COMPLETION_PROBE_DELAY_MS) => {
          if (settled) return;
          completionProbePending = true;
          clearCompletionProbeTimer();
          completionProbeTimer = setTimeout(() => {
            completionProbeTimer = null;
            if (completionProbeInFlight) {
              return;
            }
            completionProbePending = false;
            void probeCompletion();
          }, delay);
        };

        const probeCompletion = async () => {
          if (settled || completionProbeInFlight) return;
          completionProbeInFlight = true;
          const probeFinalGeneration = finalEventGeneration;

          try {
            await client.waitForRun(runId, GROUP_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
            if (firstCompletionWaitResolvedAt === null) {
              firstCompletionWaitResolvedAt = Date.now();
            }
            if (settled) return;

            let completedOutput = selectPreferredTextSnapshot(finalOutput, finalEventText);
            let settledErrorDetail = '';
            let shouldRetryForEmptyCompletion = false;
            let sawSettledAssistantText = false;
            try {
              let bestSettledAssistantText = '';
              const historyProbeStartedAt = Date.now();
              while (!settled && (Date.now() - historyProbeStartedAt) < GROUP_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
                const history = await client.getChatHistory(finalSessionKey, GROUP_HISTORY_COMPLETION_PROBE_LIMIT);
                const settledAssistantOutcome = extractSettledAssistantOutcome(history, preRunHistorySnapshot);
                if (settledAssistantOutcome.kind === 'error') {
                  settledErrorDetail = settledAssistantOutcome.error;
                  break;
                }
                if (settledAssistantOutcome.kind === 'text') {
                  sawSettledAssistantText = true;
                  bestSettledAssistantText = settledAssistantOutcome.text;
                  if (shouldPreferSettledAssistantText(completedOutput, settledAssistantOutcome.text)) {
                    completedOutput = selectPreferredTextSnapshot(completedOutput, settledAssistantOutcome.text);
                    break;
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS));
              }

              if (settledErrorDetail) {
                rejectOnce(new Error(settledErrorDetail));
                return;
              }

              if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
                completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
              }
            } catch (historyError) {
              console.warn(`[GroupChatEngine] Failed to read final history for group ${groupId}, run ${runId}:`, historyError);
              shouldRetryForEmptyCompletion = true;
            }

            if (!completedOutput.trim()) {
              shouldRetryForEmptyCompletion = true;
            }

            completedOutput = selectPreferredTextSnapshot(completedOutput, finalEventText);

            if (
              probeFinalGeneration > 0
              && probeFinalGeneration === finalEventGeneration
              && (sawSettledAssistantText || !!finalEventText.trim())
            ) {
              settledCalibrationGeneration = Math.max(settledCalibrationGeneration, probeFinalGeneration);
            }

            if (finalEventGeneration > settledCalibrationGeneration) {
              scheduleCompletionProbe(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS);
              return;
            }

            if (
              shouldRetryForEmptyCompletion
              && firstCompletionWaitResolvedAt !== null
              && (Date.now() - firstCompletionWaitResolvedAt) < GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS
            ) {
              scheduleCompletionProbe(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS);
              return;
            }

            resolveOnce(completedOutput);
          } catch (error: any) {
            if (settled) return;
            const detail = typeof error?.message === 'string' ? error.message : '';
            if (/timeout/i.test(detail)) {
              scheduleCompletionProbe();
              return;
            }
            rejectOnce(error instanceof Error ? error : new Error(detail || 'Failed waiting for group run completion.'));
          } finally {
            completionProbeInFlight = false;
            if (!settled && completionProbePending && !completionProbeTimer) {
              scheduleCompletionProbe(0);
            }
          }
        };

        const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            const nextFinalOutput = selectPreferredTextSnapshot(finalOutput, data.text);
            const didOutputChange = nextFinalOutput !== finalOutput;
            finalOutput = nextFinalOutput;
            this.updateActiveRunText(groupId, runId, finalOutput);
            if (!didOutputChange) {
              resetIdleTimeout();
              scheduleCompletionProbe();
              return;
            }
            const visibleDeltaText = rewriteVisibleFileLinks(finalOutput, { workspacePath: runtimeContext.workspacePath });
            if (msgId !== undefined) {
              this.db.updateGroupMessage(msgId, finalOutput, modelUsed);
            }
            this.emit('delta', {
              groupId,
              id: msgId,
              parent_id: parentId,
              sender_type: 'agent',
              sender_id: agentId,
              sender_name: member.display_name,
              model_used: modelUsed,
              created_at: placeholderCreatedAt,
              content: visibleDeltaText,
            });
            resetIdleTimeout();
            scheduleCompletionProbe();
          }
        };

        const onFinal = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
            if (terminalFinalText) {
              finalEventText = selectPreferredTextSnapshot(finalEventText, terminalFinalText);
              finalOutput = selectPreferredTextSnapshot(finalOutput, terminalFinalText);
              this.updateActiveRunText(groupId, runId, finalOutput);
            } else if (data.text) {
              finalOutput = selectPreferredTextSnapshot(finalOutput, data.text);
              this.updateActiveRunText(groupId, runId, finalOutput);
            }
            finalEventGeneration += 1;
            const immediateFinalText = selectPreferredTextSnapshot(finalOutput, finalEventText);
            const visibleImmediateFinalText = rewriteVisibleFileLinks(immediateFinalText, {
              workspacePath: runtimeContext.workspacePath,
            }).trim();
            const nextVisibleFinalOutput = selectPreferredTextSnapshot(visibleFinalOutput, visibleImmediateFinalText);
            if (msgId !== undefined && nextVisibleFinalOutput && visibleFinalOutput !== nextVisibleFinalOutput) {
              visibleFinalOutput = nextVisibleFinalOutput;
              this.db.updateGroupMessage(msgId, immediateFinalText, modelUsed);
              this.emit('edit', {
                groupId,
                id: msgId,
                parent_id: parentId,
                sender_type: 'agent',
                sender_id: agentId,
                sender_name: member.display_name,
                content: nextVisibleFinalOutput,
                model_used: modelUsed,
                created_at: placeholderCreatedAt,
              });
            }
            resetIdleTimeout();
            scheduleCompletionProbe(0);
          }
        };

        const onError = (data: { sessionKey: string; runId: string; error: string }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            rejectOnce(new Error(data.error));
          }
        };

        const onAborted = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            if (data.text) {
              finalOutput = selectPreferredTextSnapshot(finalOutput, data.text);
              this.updateActiveRunText(groupId, runId, finalOutput);
            }
            scheduleCompletionProbe(0);
          }
        };

        const onDisconnect = () => {
          rejectOnce(new Error('Gateway connection lost during streaming.'));
        };

        client.on('chat.delta', onDelta);
        client.on('chat.final', onFinal);
        client.on('chat.error', onError);
        client.on('chat.aborted', onAborted);
        client.on('disconnected', onDisconnect);
        resetIdleTimeout();
        scheduleCompletionProbe();
      });

      // Update DB with final content
      const protectedResponse = selectPreferredTextSnapshot(
        selectPreferredTextSnapshot(finalOutput, response),
        finalEventText,
      );
      const mentionedIds = this.parseMentions(protectedResponse, members);
      if (!protectedResponse.trim() && msgId !== undefined) {
        if (isResetCommand) {
          this.db.deleteGroupMessage(msgId);
          this.emit('delete', {
            groupId,
            id: msgId,
            parent_id: parentId,
          });
          this.clearActiveRun(groupId, runId);
          finishTyping();
          return parentId;
        }

        const { content: errMsg, messageCode, messageParams, rawDetail } = createAgentResponseFailedMessage(
          member.display_name,
          'No text output returned from the run.'
        );
        this.db.updateGroupMessage(msgId, errMsg, this.getAgentModel(agentId), null);
        this.db.updateGroupMessageSender(msgId, 'system', '系统');
        this.emit('message', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: 'system',
          sender_name: '系统',
          content: errMsg,
          messageCode,
          messageParams,
          rawDetail,
          created_at: new Date().toISOString(),
        });
        this.clearActiveRun(groupId, runId);
        finishTyping();
        return msgId;
      }

      if (msgId === undefined) {
        this.clearActiveRun(groupId, runId);
        finishTyping();
        return parentId;
      }

      this.db.updateGroupMessage(
        msgId, 
        protectedResponse, 
        this.getAgentModel(agentId), 
        mentionedIds.length > 0 ? JSON.stringify(mentionedIds) : null
      );
      const visibleResponse = selectPreferredTextSnapshot(
        visibleFinalOutput,
        rewriteVisibleFileLinks(protectedResponse, { workspacePath: runtimeContext.workspacePath }).trim(),
      );
      if (visibleResponse !== visibleFinalOutput) {
        this.emit('edit', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: agentId,
          sender_name: member.display_name,
          content: visibleResponse,
          model_used: modelUsed,
          created_at: placeholderCreatedAt,
        });
      }
      this.clearActiveRun(groupId, runId);
      finishTyping();

      // Chain forward: if the agent's response mentions other agents
      let lastMsgId = msgId;
      if (mentionedIds.length > 0) {
        for (const nextAgentId of mentionedIds) {
          if (nextAgentId !== agentId) { // Don't send to self
            const res = await this.sendToAgent(groupId, groupName, nextAgentId, protectedResponse, member.display_name, depth + 1, lastMsgId);
            if (res !== undefined) lastMsgId = res;
          }
        }
      }
      return lastMsgId;
    } catch (err: any) {
      if (activeRunId) {
        this.clearActiveRun(groupId, activeRunId);
      }
      finishTyping();
      console.error(`[GroupChatEngine] sendToAgent Error. Group: ${groupId}, Agent: ${agentId}`, err);
      const rawDetail = typeof err?.rawDetail === 'string'
        ? err.rawDetail
        : (typeof err?.message === 'string' ? err.message : '');
      const messageCode = err instanceof AudioPreparationError
        ? err.messageCode
        : undefined;
      const messageParams = messageCode ? undefined : { agentName: member.display_name };
      const errMsg = messageCode
        ? (rawDetail || messageCode)
        : createAgentResponseFailedMessage(member.display_name, rawDetail).content;
      
      if (msgId !== undefined) {
        this.db.updateGroupMessage(msgId, errMsg, this.getAgentModel(agentId), null);
        this.db.updateGroupMessageSender(msgId, 'system', '系统');
        this.emit('message', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: 'system',
          sender_name: '系统',
          content: errMsg,
          messageCode: messageCode || AGENT_RESPONSE_FAILED_MESSAGE_CODE,
          messageParams,
          rawDetail,
          created_at: new Date().toISOString(),
        });
      }
      return msgId || parentId;
    } finally {
      if (activeRunId) {
        this.clearActiveRun(groupId, activeRunId);
      }
      if (msgId !== undefined) {
        this.clearPendingRun(groupId, msgId);
      }
      finishTyping();
    }
  }
}

export default GroupChatEngine;
