import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createServer } from 'http';
import multer from 'multer';
import { WebSocket } from 'ws';
import OpenClawClient, { extractOpenClawMessageText } from './openclaw-client';
import SessionManager from './session-manager';
import ConfigManager from './config-manager';
import DB from './db';
import AgentProvisioner from './agent-provisioner';
import { GroupChatEngine, createAgentResponseFailedMessage, getStructuredGroupMessage } from './group-chat-engine';
import {
  deleteGroupWorkspace,
  ensureGroupWorkspace,
  getAgentMemoryDbPath,
  getAgentStatePath,
  getGroupRuntimeSessionKey,
  getGroupWorkspacePath,
  getGroupRuntimeAgentPrefix,
  getLegacyGroupRuntimeAgentId,
  getGroupRuntimeAgentId,
  getSharedGroupRuntimeAgentId,
  resetGroupWorkspace,
  validateGroupId,
} from './group-workspace';
import { exec, execFile, spawn } from 'child_process';
import util from 'util';
import net from 'net';
import sharp from 'sharp';
import { rewriteMessageWithWorkspaceUploads } from './message-upload-rewrite';
import { rewriteVisibleFileLinks } from './file-link-rewrite';
import type { ChatRow, MessagePageInfo, MessageSearchMatch, StoredFileRow } from './db';
import {
  type ChatHistorySnapshot,
  extractLatestAssistantOutcomeRecord,
  extractSettledAssistantOutcome,
  getHistorySnapshot,
  shouldPreferSettledAssistantText,
} from './chat-history-reconciliation';
import { selectPreferredTextSnapshot } from './text-snapshot-protection';
import { getCurrentAppVersionInfo, getLatestVersionInfo, type LatestVersionInfo as AppLatestVersionInfo } from './app-version';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

const dataDir = process.env.CLAWUI_DATA_DIR || '.clawui';
const uploadDir = path.join(process.env.HOME || '.', dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// OpenClaw media directory (screenshots, inbound files, etc.)
const openclawMediaDir = path.join(process.env.HOME || '.', '.openclaw', 'media');

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const target = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
      fs.mkdirSync(target.uploadsPath, { recursive: true });
      console.log(`[Upload] Context: ${target.contextType}, SessionKey: ${target.sessionKey}, Path: ${target.uploadsPath}`);
      cb(null, target.uploadsPath);
    } catch (err) {
      cb(err as Error, uploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = decodedName.replace(/[^a-zA-Z0-9.\u4e00-\u9fa5_-]/g, '_');
    file.originalname = decodedName; // Save decoded name back for later use
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// Initialize managers
const db = new DB();
const configManager = new ConfigManager();
const sessionManager = new SessionManager(db);
const agentProvisioner = new AgentProvisioner();
type StructuredMessageParams = Record<string, string | number | boolean | null>;
const CHAT_RUN_ERROR_CODE = 'chat.runError';
const CHAT_GATEWAY_DISCONNECTED_CODE = 'chat.gatewayDisconnected';
const CHAT_GATEWAY_DISCONNECTED_DETAIL = 'Connection to gateway lost. The process might have restarted.';
const CHAT_RUN_ERROR_PREFIX = '❌ Error: ';
const GATEWAY_TEST_FAILED_ERROR_CODE = 'gateway.testFailed';
const GATEWAY_RESTART_FAILED_ERROR_CODE = 'gateway.restartFailed';
const GATEWAY_DETECT_FAILED_ERROR_CODE = 'gateway.detectFailed';
const BROWSER_HEALTH_FAILED_ERROR_CODE = 'gateway.browserHealthFailed';
const BROWSER_SELF_HEAL_FAILED_ERROR_CODE = 'gateway.browserSelfHealFailed';
const BROWSER_TASK_BUSY_ERROR_CODE = 'gateway.browserTaskBusy';
const BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE = 'gateway.browserHeadedModeLoadFailed';
const BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE = 'gateway.browserHeadedModeUpdateFailed';
const AGENT_ID_REQUIRED_ERROR_CODE = 'agents.idRequired';
const AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE = 'agents.idContainsWhitespace';
const AGENT_ID_ALREADY_EXISTS_ERROR_CODE = 'agents.idAlreadyExists';
const GROUP_ID_REQUIRED_ERROR_CODE = 'groups.idRequired';
const GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE = 'groups.idContainsWhitespace';
const GROUP_ID_INVALID_ERROR_CODE = 'groups.idInvalid';
const GROUP_ID_ALREADY_EXISTS_ERROR_CODE = 'groups.idAlreadyExists';
const GROUP_NOT_FOUND_ERROR_CODE = 'groups.notFound';
const GROUP_RUN_IN_PROGRESS_ERROR_CODE = 'groups.runInProgress';
const MODEL_CREATE_FAILED_ERROR_CODE = 'models.createFailed';
const MODEL_UPDATE_FAILED_ERROR_CODE = 'models.updateFailed';
const MODEL_DELETE_FAILED_ERROR_CODE = 'models.deleteFailed';
const MODEL_TEST_FAILED_ERROR_CODE = 'models.testFailed';
const MODEL_DISCOVER_FAILED_ERROR_CODE = 'models.discoverFailed';
const ENDPOINT_CREATE_FAILED_ERROR_CODE = 'endpoints.createFailed';
const ENDPOINT_DELETE_FAILED_ERROR_CODE = 'endpoints.deleteFailed';
const ENDPOINT_TEST_FAILED_ERROR_CODE = 'endpoints.testFailed';
const AUTH_LOGIN_REQUIRED_ERROR_CODE = 'auth.loginRequired';
const VERSION_INFO_UNAVAILABLE_ERROR_CODE = 'version.infoUnavailable';
const VERSION_LOOKUP_FAILED_ERROR_CODE = 'version.lookupFailed';
const OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE = 'openclawVersion.lookupFailed';
const UPDATE_START_FAILED_ERROR_CODE = 'update.startFailed';
const UPDATE_ALREADY_RUNNING_ERROR_CODE = 'update.alreadyRunning';
const UPDATE_NO_NEW_VERSION_ERROR_CODE = 'update.noNewVersion';
const UPDATE_CANCEL_FAILED_ERROR_CODE = 'update.cancelFailed';
const UPDATE_NOT_RUNNING_ERROR_CODE = 'update.notRunning';
const UPDATE_CANNOT_CANCEL_PHASE_ERROR_CODE = 'update.cannotCancelCurrentPhase';
const UPDATE_RESET_FAILED_ERROR_CODE = 'update.resetFailed';
const UPDATE_RESTART_FAILED_ERROR_CODE = 'update.restartFailed';
const UPDATE_RESTART_NOT_READY_ERROR_CODE = 'update.restartNotReady';
const UPDATE_SERVICE_NOT_FOUND_ERROR_CODE = 'update.serviceNotFound';
const OPENCLAW_UPDATE_START_FAILED_ERROR_CODE = 'openclawUpdate.startFailed';
const OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE = 'openclawUpdate.alreadyRunning';
const OPENCLAW_UPDATE_NO_NEW_VERSION_ERROR_CODE = 'openclawUpdate.noNewVersion';
const OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE = 'openclawUpdate.cancelFailed';
const OPENCLAW_UPDATE_NOT_RUNNING_ERROR_CODE = 'openclawUpdate.notRunning';
const OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE = 'openclawUpdate.resetFailed';
const DEFAULT_HISTORY_PAGE_LIMIT = 200;
const MAX_HISTORY_PAGE_LIMIT = 200;
const CHAT_STREAM_COMPLETION_PROBE_DELAY_MS = 400;
const CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
const CHAT_HISTORY_COMPLETION_PROBE_LIMIT = 60;
const CHAT_REGENERATE_LOOKBACK_LIMIT = 60;
const CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
const CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
const CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
const GROUP_SSE_KEEPALIVE_MS = 15000;
const BROWSER_HEALTH_CLI_TIMEOUT_MS = 15000;
const BROWSER_HEALTH_EXEC_TIMEOUT_MS = 20000;
const BROWSER_HEALTH_PROFILE = 'openclaw';
const BROWSER_HEALTH_VALIDATION_URL = 'https://example.com';
const BROWSER_HEALTH_FALLBACK_VALIDATION_URL = 'http://example.com';
const BROWSER_HEALTH_START_TIMEOUT_MS = 30000;
const BROWSER_HEALTH_OPEN_TIMEOUT_MS = 40000;
const BROWSER_HEALTH_SNAPSHOT_TIMEOUT_MS = 45000;
const BROWSER_SELF_HEAL_STOP_TIMEOUT_MS = 8000;
const BROWSER_SELF_HEAL_POLL_TIMEOUT_MS = 25000;
const BROWSER_SELF_HEAL_POLL_INTERVAL_MS = 1000;
const UPDATE_SCRIPT_URL = 'https://raw.githubusercontent.com/liandu2024/OpenClaw-Chat-Gateway/main/update.sh';
const UPDATE_PHASE_MARKER_PREFIX = '::clawui-update-phase::';
const UPDATE_LOG_LIMIT = 200;
const UPDATE_CANCEL_KILL_TIMEOUT_MS = 5000;
const UPDATE_RESTART_DELAY_MS = 250;
const UPDATE_CANCELLABLE_PHASES = new Set(['downloading-script', 'detect-service', 'git-pull']);
const CLAWUI_SERVICE_FILE_REGEX = /^clawui(?:-\d+)?\.service$/;

type BrowserHealthIssue = 'permissions' | 'disabled' | 'stopped' | 'detect-error' | 'timeout' | 'unknown';

type BrowserHealthSnapshot = {
  healthy: boolean;
  issue: BrowserHealthIssue | null;
  checkedAt: number;
  maxPermissionsEnabled: boolean | null;
  profile: string | null;
  enabled: boolean | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
  rawDetail: string | null;
  validationSucceeded: boolean | null;
  validationDetail: string | null;
  config: BrowserConfigState;
  runtime: BrowserRuntimeState | null;
};

type BrowserConfigState = {
  enabled: boolean | null;
  headless: boolean | null;
  profile: string | null;
  executablePath: string | null;
  noSandbox: boolean | null;
  attachOnly: boolean | null;
  cdpPort: number | null;
};

type BrowserRuntimeState = {
  profile: string | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
};

type BrowserHeadedModeConfig = {
  headless: boolean;
  headedModeEnabled: boolean;
};

type BrowserHealthDiagnostics = Omit<BrowserHealthSnapshot, 'healthy' | 'issue' | 'validationSucceeded' | 'validationDetail'>;

type BrowserTaskStatus = 'idle' | 'checking' | 'repairing';

type BrowserTaskSnapshot = {
  status: BrowserTaskStatus;
  phase: string | null;
  rawDetail: string | null;
  updatedAt: string | null;
};

type UpdateStatus =
  | 'idle'
  | 'has_update'
  | 'checking'
  | 'updating'
  | 'stopping'
  | 'update_succeeded'
  | 'update_failed'
  | 'restarting'
  | 'restart_failed';

type UpdateSnapshot = {
  status: UpdateStatus;
  phase: string | null;
  canCancel: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  message: string | null;
  rawDetail: string | null;
  logs: string[];
  startedAt: string | null;
  updatedAt: string | null;
  serviceName: string | null;
};

type ActiveUpdateProcess = {
  child: ReturnType<typeof spawn>;
  startCommit: string | null;
  cancelRequested: boolean;
  cancelTimer: NodeJS.Timeout | null;
};

type OpenClawLatestVersionInfo = {
  currentVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  status: 'update_available' | 'up_to_date';
  channel: string | null;
  channelLabel: string | null;
  installKind: string | null;
  packageManager: string | null;
};

type OpenClawUpdateStatus =
  | 'idle'
  | 'checking'
  | 'updating'
  | 'stopping'
  | 'update_succeeded'
  | 'update_failed';

type OpenClawUpdateSnapshot = {
  status: OpenClawUpdateStatus;
  phase: string | null;
  canCancel: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  message: string | null;
  rawDetail: string | null;
  logs: string[];
  startedAt: string | null;
  updatedAt: string | null;
};

type ActiveOpenClawUpdateProcess = {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
  cancelTimer: NodeJS.Timeout | null;
  phaseTimer: NodeJS.Timeout | null;
};

const appRepoRoot = path.resolve(__dirname, '..', '..');
const OPENCLAW_LATEST_VERSION_CACHE_TTL_MS = 60 * 1000;
const OPENCLAW_UPDATE_CANCELLABLE_PHASES = new Set([
  'download-package',
  'install-package',
  'running-update',
]);

function createDefaultUpdateSnapshot(): UpdateSnapshot {
  return {
    status: 'idle',
    phase: null,
    canCancel: false,
    currentVersion: getCurrentAppVersionInfo().version,
    latestVersion: null,
    message: null,
    rawDetail: null,
    logs: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    serviceName: null,
  };
}

function createDefaultOpenClawUpdateSnapshot(): OpenClawUpdateSnapshot {
  return {
    status: 'idle',
    phase: null,
    canCancel: false,
    currentVersion: null,
    latestVersion: null,
    message: null,
    rawDetail: null,
    logs: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

let updateSnapshot = createDefaultUpdateSnapshot();
let activeUpdateProcess: ActiveUpdateProcess | null = null;
let cachedLatestVersionInfo: AppLatestVersionInfo | null = null;
let openClawUpdateSnapshot = createDefaultOpenClawUpdateSnapshot();
let activeOpenClawUpdateProcess: ActiveOpenClawUpdateProcess | null = null;
let cachedOpenClawLatestVersionInfo: OpenClawLatestVersionInfo | null = null;
let cachedOpenClawLatestVersionCheckedAt = 0;

function appendUpdateLog(message: string) {
  const line = normalizeCliText(message);
  if (!line) return;
  updateSnapshot.logs = [...updateSnapshot.logs.slice(-(UPDATE_LOG_LIMIT - 1)), line];
  updateSnapshot.updatedAt = new Date().toISOString();
}

function patchUpdateSnapshot(patch: Partial<UpdateSnapshot>) {
  updateSnapshot = {
    ...updateSnapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function resetUpdateSnapshot() {
  updateSnapshot = createDefaultUpdateSnapshot();
}

function rememberLatestVersionInfo(info: AppLatestVersionInfo | null) {
  cachedLatestVersionInfo = info;
  if (!info) {
    if (updateSnapshot.status === 'has_update') {
      patchUpdateSnapshot({
        status: 'idle',
        latestVersion: null,
      });
    }
    return;
  }

  if (activeUpdateProcess || ['checking', 'updating', 'stopping', 'update_succeeded', 'update_failed', 'restarting', 'restart_failed'].includes(updateSnapshot.status)) {
    return;
  }

  patchUpdateSnapshot({
    status: info.hasUpdate ? 'has_update' : 'idle',
    latestVersion: info.latestVersion || null,
    currentVersion: info.currentVersion || getCurrentAppVersionInfo().version,
    message: null,
    rawDetail: null,
  });
}

function getUpdatePhaseMessage(phase: string) {
  switch (phase) {
    case 'downloading-script':
      return 'Downloading update script.';
    case 'detect-service':
      return 'Detecting current service.';
    case 'git-pull':
      return 'Pulling the latest code.';
    case 'deploy-release':
      return 'Running deploy-release.sh.';
    case 'install-dependencies':
      return 'Installing dependencies.';
    case 'build':
      return 'Building the project.';
    case 'patch-config':
      return 'Patching OpenClaw configuration.';
    case 'reconcile-openclaw-runtime':
      return 'Reconciling OpenClaw runtime.';
    case 'repair-openclaw-device':
      return 'Repairing local OpenClaw device scopes.';
    case 'recover-browser-runtime':
      return 'Recovering and validating browser runtime.';
    case 'setup-service':
      return 'Updating service configuration.';
    case 'service-restart':
      return 'Restarting service.';
    case 'complete':
      return 'Update completed.';
    default:
      return null;
  }
}

function updatePhaseState(phase: string) {
  patchUpdateSnapshot({
    phase,
    canCancel: UPDATE_CANCELLABLE_PHASES.has(phase),
    message: getUpdatePhaseMessage(phase),
  });
}

function consumeUpdateOutputLine(line: string, source: 'stdout' | 'stderr') {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return;
  appendUpdateLog(trimmed);
  if (trimmed.startsWith(UPDATE_PHASE_MARKER_PREFIX)) {
    const phase = normalizeCliText(trimmed.slice(UPDATE_PHASE_MARKER_PREFIX.length));
    if (phase) updatePhaseState(phase);
    return;
  }
  if (source === 'stderr') {
    patchUpdateSnapshot({
      rawDetail: trimmed,
    });
  }
}

function attachUpdateOutput(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr') {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      consumeUpdateOutputLine(line, source);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer) {
      consumeUpdateOutputLine(buffer, source);
      buffer = '';
    }
  });
}

async function readGitHeadCommit() {
  try {
    const { stdout } = await execFilePromise('git', ['rev-parse', 'HEAD'], {
      cwd: appRepoRoot,
      maxBuffer: 1024 * 1024,
    });
    return normalizeCliText(stdout) || null;
  } catch {
    return null;
  }
}

async function cleanupUpdateResidualFiles() {
  const lockFiles = [
    path.join(appRepoRoot, '.git', 'index.lock'),
    path.join(appRepoRoot, '.git', 'HEAD.lock'),
    path.join(appRepoRoot, '.git', 'FETCH_HEAD.lock'),
    path.join(appRepoRoot, '.git', 'shallow.lock'),
    path.join(appRepoRoot, '.git', 'config.lock'),
    path.join(appRepoRoot, '.git', 'ORIG_HEAD.lock'),
  ];

  for (const filePath of lockFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

async function revertUpdateWorkspace(startCommit: string | null) {
  if (!startCommit) return;
  await execFilePromise('git', ['reset', '--hard', startCommit], {
    cwd: appRepoRoot,
    maxBuffer: 1024 * 1024,
  });
  await cleanupUpdateResidualFiles();
}

function buildUpdateStatusResponse(): UpdateSnapshot {
  if (updateSnapshot.status === 'idle' && cachedLatestVersionInfo?.hasUpdate) {
    return {
      ...updateSnapshot,
      status: 'has_update',
      latestVersion: cachedLatestVersionInfo.latestVersion || updateSnapshot.latestVersion,
      currentVersion: cachedLatestVersionInfo.currentVersion || updateSnapshot.currentVersion,
    };
  }

  return {
    ...updateSnapshot,
  };
}

function appendOpenClawUpdateLog(message: string) {
  const line = normalizeCliText(message);
  if (!line) return;
  openClawUpdateSnapshot.logs = [...openClawUpdateSnapshot.logs.slice(-(UPDATE_LOG_LIMIT - 1)), line];
  openClawUpdateSnapshot.updatedAt = new Date().toISOString();
}

function patchOpenClawUpdateSnapshot(patch: Partial<OpenClawUpdateSnapshot>) {
  openClawUpdateSnapshot = {
    ...openClawUpdateSnapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function resetOpenClawUpdateSnapshot() {
  openClawUpdateSnapshot = createDefaultOpenClawUpdateSnapshot();
}

function rememberOpenClawLatestVersionInfo(info: OpenClawLatestVersionInfo | null) {
  cachedOpenClawLatestVersionInfo = info;
  cachedOpenClawLatestVersionCheckedAt = info ? Date.now() : 0;
}

function getCachedOpenClawLatestVersionInfo(currentVersion?: string | null): OpenClawLatestVersionInfo | null {
  if (!cachedOpenClawLatestVersionInfo || !cachedOpenClawLatestVersionCheckedAt) {
    return null;
  }

  if ((Date.now() - cachedOpenClawLatestVersionCheckedAt) > OPENCLAW_LATEST_VERSION_CACHE_TTL_MS) {
    rememberOpenClawLatestVersionInfo(null);
    return null;
  }

  if (
    currentVersion
    && cachedOpenClawLatestVersionInfo.currentVersion
    && cachedOpenClawLatestVersionInfo.currentVersion !== currentVersion
  ) {
    return null;
  }

  return cachedOpenClawLatestVersionInfo;
}

function getOpenClawUpdatePhaseMessage(phase: string) {
  switch (phase) {
    case 'checking-status':
      return 'Checking the latest OpenClaw version.';
    case 'download-package':
      return 'Downloading the OpenClaw update package.';
    case 'install-package':
      return 'Installing the OpenClaw update package.';
    case 'switch-command-entrypoint':
      return 'Switching the OpenClaw command entrypoint.';
    case 'finalize-update':
      return 'Finalizing the OpenClaw package update.';
    case 'running-update':
      return 'Updating OpenClaw.';
    case 'stopping-update':
      return 'Stopping the OpenClaw update.';
    case 'repair-command-entrypoint':
      return 'Repairing the OpenClaw command entrypoint.';
    case 'verifying-version':
      return 'Verifying the upgraded OpenClaw version.';
    case 'complete':
      return 'OpenClaw update completed.';
    default:
      return null;
  }
}

function patchOpenClawUpdatePhaseState(phase: string, patch: Partial<OpenClawUpdateSnapshot> = {}) {
  patchOpenClawUpdateSnapshot({
    phase,
    canCancel: OPENCLAW_UPDATE_CANCELLABLE_PHASES.has(phase),
    message: getOpenClawUpdatePhaseMessage(phase) || openClawUpdateSnapshot.message,
    ...patch,
  });
}

function buildOpenClawUpdateStatusResponse(): OpenClawUpdateSnapshot {
  return {
    ...openClawUpdateSnapshot,
  };
}

function collectOpenClawUpdateTextFragments(value: unknown, fragments: string[] = [], seen = new Set<string>()) {
  if (typeof value === 'string') {
    const normalized = normalizeCliText(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      fragments.push(normalized);
    }
    return fragments;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectOpenClawUpdateTextFragments(entry, fragments, seen);
    }
    return fragments;
  }

  if (!value || typeof value !== 'object') {
    return fragments;
  }

  const objectValue = value as Record<string, unknown>;
  for (const key of ['message', 'detail', 'summary', 'phase', 'stage', 'step', 'action', 'status', 'event']) {
    if (key in objectValue) {
      collectOpenClawUpdateTextFragments(objectValue[key], fragments, seen);
    }
  }

  for (const key of ['data', 'payload', 'result', 'update']) {
    if (key in objectValue) {
      collectOpenClawUpdateTextFragments(objectValue[key], fragments, seen);
    }
  }

  return fragments;
}

function inferOpenClawUpdatePhaseFromText(text: string) {
  const normalized = normalizeCliText(text).toLowerCase();
  if (!normalized) return null;

  if (/(download|downloading|fetching|retriev|tarball|archive|artifact)/i.test(normalized)) {
    return 'download-package';
  }
  if (/(extract|extracting|unpack|unpacking|install(?:ing|ed)?|apply(?:ing)?|copy(?:ing)? files?|prepar(?:e|ing).*package|node_modules)/i.test(normalized)) {
    return 'install-package';
  }
  if (/(switch|switching|replace|replacing|activate|activating|link|symlink|launcher|entrypoint|bin\/openclaw|shell command)/i.test(normalized)) {
    return 'switch-command-entrypoint';
  }
  if (/(cleanup|cleaning|clean up|finaliz|finishing|completed|postinstall)/i.test(normalized)) {
    return 'finalize-update';
  }
  if (/(verif|confirming version|checking version|validate version)/i.test(normalized)) {
    return 'verifying-version';
  }
  if (/(check|checking).*(update|version)|latest version/i.test(normalized)) {
    return 'checking-status';
  }

  return null;
}

function inferOpenClawUpdatePhaseFromPayload(payload: unknown): string | null {
  const fragments = collectOpenClawUpdateTextFragments(payload);
  for (const fragment of fragments) {
    const phase = inferOpenClawUpdatePhaseFromText(fragment);
    if (phase) {
      return phase;
    }
  }
  return null;
}

function parseOpenClawUpdateOutputLine(line: string) {
  const normalized = normalizeCliText(line);
  if (!normalized) {
    return {
      logLine: '',
      phase: null as string | null,
    };
  }

  let logLine = normalized;
  let phase = inferOpenClawUpdatePhaseFromText(normalized);

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const fragments = collectOpenClawUpdateTextFragments(parsed);
    if (fragments.length > 0) {
      logLine = fragments.join(' | ');
    }
    phase = inferOpenClawUpdatePhaseFromPayload(parsed) || phase;
  } catch {}

  return {
    logLine,
    phase,
  };
}

function patchOpenClawUpdateRunningPhase(phase: string | null) {
  if (!phase || openClawUpdateSnapshot.status !== 'updating') {
    return;
  }

  if (openClawUpdateSnapshot.phase === phase) {
    return;
  }

  patchOpenClawUpdatePhaseState(phase);
}

function attachOpenClawUpdateOutput(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr') {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        const parsedLine = parseOpenClawUpdateOutputLine(line);
        appendOpenClawUpdateLog(parsedLine.logLine || line);
        patchOpenClawUpdateRunningPhase(parsedLine.phase);
        if (source === 'stderr') {
          patchOpenClawUpdateSnapshot({
            rawDetail: parsedLine.logLine || line,
          });
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    const line = buffer.replace(/\r$/, '');
    if (!line.trim()) return;
    const parsedLine = parseOpenClawUpdateOutputLine(line);
    appendOpenClawUpdateLog(parsedLine.logLine || line);
    patchOpenClawUpdateRunningPhase(parsedLine.phase);
    if (source === 'stderr') {
      patchOpenClawUpdateSnapshot({
        rawDetail: parsedLine.logLine || line,
      });
    }
  });
}

async function getOpenClawLatestVersionInfo(): Promise<OpenClawLatestVersionInfo> {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  const { stdout } = await execFilePromise(executablePath, ['update', 'status', '--json'], {
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(normalizeCliText(stdout) || '{}') as {
    update?: { installKind?: string; packageManager?: string };
    channel?: { value?: string; label?: string };
    availability?: { available?: boolean; latestVersion?: string | null };
  };
  const currentVersion = await readOpenClawVersion();
  const latestVersion = normalizeCliText(parsed?.availability?.latestVersion) || null;
  const hasUpdate = Boolean(parsed?.availability?.available && latestVersion && currentVersion && latestVersion !== currentVersion);

  const info: OpenClawLatestVersionInfo = {
    currentVersion,
    latestVersion,
    hasUpdate,
    status: hasUpdate ? 'update_available' : 'up_to_date',
    channel: normalizeCliText(parsed?.channel?.value) || null,
    channelLabel: normalizeCliText(parsed?.channel?.label) || null,
    installKind: normalizeCliText(parsed?.update?.installKind) || null,
    packageManager: normalizeCliText(parsed?.update?.packageManager) || null,
  };
  rememberOpenClawLatestVersionInfo(info);
  return info;
}

async function startOpenClawUpdateTask() {
  if (activeOpenClawUpdateProcess || ['checking', 'updating'].includes(openClawUpdateSnapshot.status)) {
    throw new StructuredRequestError(409, OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE, 'An OpenClaw update task is already running.');
  }

  const currentVersion = await readOpenClawVersion();
  const cachedLatestInfo = getCachedOpenClawLatestVersionInfo(currentVersion);

  if (!cachedLatestInfo) {
    patchOpenClawUpdateSnapshot({
      status: 'checking',
      phase: 'checking-status',
      canCancel: false,
      currentVersion,
      latestVersion: null,
      message: getOpenClawUpdatePhaseMessage('checking-status'),
      rawDetail: null,
      logs: [],
      startedAt: new Date().toISOString(),
    });
  }

  const latestInfo = cachedLatestInfo || await getOpenClawLatestVersionInfo();
  if (!latestInfo.hasUpdate || !latestInfo.latestVersion) {
    resetOpenClawUpdateSnapshot();
    throw new StructuredRequestError(409, OPENCLAW_UPDATE_NO_NEW_VERSION_ERROR_CODE, 'No newer OpenClaw version is available.');
  }

  const executablePath = await ensureResolvedOpenClawExecutablePath(latestInfo.latestVersion);
  const child = spawn(executablePath, ['update', '--json', '--yes'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });

  activeOpenClawUpdateProcess = {
    child,
    cancelRequested: false,
    cancelTimer: null,
    phaseTimer: null,
  };

  patchOpenClawUpdatePhaseState('download-package', {
    status: 'updating',
    currentVersion: latestInfo.currentVersion,
    latestVersion: latestInfo.latestVersion,
    rawDetail: null,
  });
  appendOpenClawUpdateLog(`Starting OpenClaw update to ${latestInfo.latestVersion}.`);

  activeOpenClawUpdateProcess.phaseTimer = setTimeout(() => {
    if (
      activeOpenClawUpdateProcess?.child.pid === child.pid
      && openClawUpdateSnapshot.status === 'updating'
      && openClawUpdateSnapshot.phase === 'download-package'
    ) {
      patchOpenClawUpdatePhaseState('install-package');
    }
  }, 1500);

  attachOpenClawUpdateOutput(child.stdout, 'stdout');
  attachOpenClawUpdateOutput(child.stderr, 'stderr');

  child.once('error', (error) => {
    if (activeOpenClawUpdateProcess?.phaseTimer) {
      clearTimeout(activeOpenClawUpdateProcess.phaseTimer);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    patchOpenClawUpdateSnapshot({
      status: 'update_failed',
      phase: 'running-update',
      canCancel: false,
      message: 'OpenClaw update failed.',
      rawDetail: detail,
    });
    appendOpenClawUpdateLog(`OpenClaw update failed to start: ${detail}`);
    activeOpenClawUpdateProcess = null;
  });

  child.once('close', async (code, signal) => {
    const activeProcess = activeOpenClawUpdateProcess;
    activeOpenClawUpdateProcess = null;
    if (activeProcess?.cancelTimer) {
      clearTimeout(activeProcess.cancelTimer);
    }
    if (activeProcess?.phaseTimer) {
      clearTimeout(activeProcess.phaseTimer);
    }

    if (activeProcess?.cancelRequested) {
      resetOpenClawUpdateSnapshot();
      appendOpenClawUpdateLog('OpenClaw update cancelled.');
      return;
    }

    if (code === 0) {
      try {
        patchOpenClawUpdatePhaseState('repair-command-entrypoint');
        const resolvedExecutablePath = await ensureResolvedOpenClawExecutablePath(latestInfo.latestVersion);
        await ensureOpenClawShellEntrypoint(resolvedExecutablePath);
        appendOpenClawUpdateLog('Verified and repaired the OpenClaw shell entrypoint.');
        patchOpenClawUpdatePhaseState('verifying-version');
        const verifiedInfo = await getOpenClawLatestVersionInfo();
        patchOpenClawUpdateSnapshot({
          status: 'update_succeeded',
          phase: 'complete',
          canCancel: false,
          currentVersion: verifiedInfo.currentVersion,
          latestVersion: verifiedInfo.latestVersion,
          message: getOpenClawUpdatePhaseMessage('complete'),
          rawDetail: null,
        });
        appendOpenClawUpdateLog(`OpenClaw update completed successfully. Current version: ${verifiedInfo.currentVersion || 'unknown'}.`);
      } catch (error) {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        patchOpenClawUpdateSnapshot({
          status: 'update_failed',
          phase: 'verifying-version',
          canCancel: false,
          message: 'OpenClaw update verification failed.',
          rawDetail: detail,
        });
        appendOpenClawUpdateLog(`OpenClaw update completed, but verification failed: ${detail}`);
      }
      return;
    }

    const detail = openClawUpdateSnapshot.rawDetail
      || `OpenClaw update exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
    patchOpenClawUpdateSnapshot({
      status: 'update_failed',
      phase: 'running-update',
      canCancel: false,
      message: 'OpenClaw update failed.',
      rawDetail: detail,
    });
    appendOpenClawUpdateLog(`OpenClaw update failed: ${detail}`);
  });

  return buildOpenClawUpdateStatusResponse();
}

async function resetOpenClawUpdateTaskState() {
  if (activeOpenClawUpdateProcess) {
    throw new StructuredRequestError(409, OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE, 'Cannot reset while an OpenClaw update task is running.');
  }
  resetOpenClawUpdateSnapshot();
  return buildOpenClawUpdateStatusResponse();
}

async function cancelOpenClawUpdateTask() {
  if (!activeOpenClawUpdateProcess || !['checking', 'updating', 'stopping'].includes(openClawUpdateSnapshot.status)) {
    throw new StructuredRequestError(409, OPENCLAW_UPDATE_NOT_RUNNING_ERROR_CODE, 'There is no running OpenClaw update task to stop.');
  }

  if (openClawUpdateSnapshot.status === 'stopping') {
    return buildOpenClawUpdateStatusResponse();
  }

  patchOpenClawUpdateSnapshot({
    status: 'stopping',
    phase: 'stopping-update',
    canCancel: false,
    message: getOpenClawUpdatePhaseMessage('stopping-update'),
  });
  appendOpenClawUpdateLog('Stopping OpenClaw update on user request.');

  activeOpenClawUpdateProcess.cancelRequested = true;
  try {
    process.kill(-activeOpenClawUpdateProcess.child.pid!, 'SIGTERM');
  } catch (error) {
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    patchOpenClawUpdateSnapshot({
      status: 'update_failed',
      phase: 'stopping-update',
      canCancel: false,
      message: 'Failed to stop the OpenClaw update.',
      rawDetail: detail,
    });
    throw new StructuredRequestError(500, OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE, detail);
  }

  activeOpenClawUpdateProcess.cancelTimer = setTimeout(() => {
    try {
      if (activeOpenClawUpdateProcess?.cancelRequested) {
        process.kill(-activeOpenClawUpdateProcess.child.pid!, 'SIGKILL');
      }
    } catch {}
  }, UPDATE_CANCEL_KILL_TIMEOUT_MS);

  return buildOpenClawUpdateStatusResponse();
}

function getCurrentClawUiPort() {
  return normalizeCliText(process.env.PORT) || '3115';
}

function resolveClawUiServiceName() {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const currentPort = getCurrentClawUiPort();
  const preferred = `clawui-${currentPort}.service`;
  const preferredPath = path.join(serviceDir, preferred);
  if (fs.existsSync(preferredPath)) {
    return preferred;
  }

  const legacyPath = path.join(serviceDir, 'clawui.service');
  if (currentPort === '3115' && fs.existsSync(legacyPath)) {
    return 'clawui.service';
  }

  try {
    const candidates = fs.readdirSync(serviceDir).filter((entry) => CLAWUI_SERVICE_FILE_REGEX.test(entry));
    if (candidates.includes(preferred)) return preferred;
    if (candidates.includes('clawui.service')) return 'clawui.service';
    if (candidates.length === 1) return candidates[0];
  } catch {}

  throw new StructuredRequestError(404, UPDATE_SERVICE_NOT_FOUND_ERROR_CODE, `Could not determine the current ClawUI service for port ${currentPort}.`);
}

function buildStructuredApiError(
  errorCode: string,
  errorDetail?: string | null,
  errorParams?: StructuredMessageParams | null
) {
  return {
    success: false as const,
    errorCode,
    errorParams: errorParams || null,
    errorDetail: typeof errorDetail === 'string' && errorDetail.trim() ? errorDetail.trim() : null,
  };
}

class StructuredRequestError extends Error {
  status: number;
  payload: ReturnType<typeof buildStructuredApiError>;

  constructor(
    status: number,
    errorCode: string,
    errorDetail?: string | null,
    errorParams?: StructuredMessageParams | null
  ) {
    super(errorDetail || errorCode);
    this.status = status;
    this.payload = buildStructuredApiError(errorCode, errorDetail, errorParams);
  }
}

function isStructuredRequestError(error: unknown): error is StructuredRequestError {
  return error instanceof StructuredRequestError;
}

function normalizeCliText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeCliText(hostname).toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]';
}

function parseGatewayUrlForStatusProbe(gatewayUrl: string): { hostname: string; port: number | null } | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    const port = parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'https:' ? 443 : 80);

    return {
      hostname: parsed.hostname,
      port: Number.isFinite(port) ? port : null,
    };
  } catch {
    return null;
  }
}

function buildGatewayHttpBaseUrl(gatewayUrl: string): string | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function readLocalGatewayRuntimeConfig(): {
  port: number | null;
  token: string;
  password: string;
} | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const gateway = raw?.gateway;
    if (!gateway || typeof gateway !== 'object') return null;

    const parsedPort = Number(gateway.port);
    return {
      port: Number.isFinite(parsedPort) ? parsedPort : null,
      token: normalizeCliText(gateway.auth?.token),
      password: normalizeCliText(gateway.auth?.password),
    };
  } catch {
    return null;
  }
}

async function probeGatewayHealth(gatewayUrl: string): Promise<{ ok: boolean; message?: string }> {
  const baseUrl = buildGatewayHttpBaseUrl(gatewayUrl);
  if (!baseUrl) {
    return { ok: false, message: 'Invalid gateway URL' };
  }

  try {
    const response = await axios.get(`${baseUrl}/health`, {
      timeout: 1500,
      validateStatus: () => true,
    });
    const statusText = normalizeCliText((response.data as any)?.status).toLowerCase();
    const ok = response.status >= 200
      && response.status < 300
      && (((response.data as any)?.ok === true) || statusText === 'live' || statusText === 'ok');

    return ok
      ? { ok: true }
      : { ok: false, message: `Gateway health probe returned HTTP ${response.status}` };
  } catch (error: any) {
    return {
      ok: false,
      message: readCliErrorDetail(error) || 'Gateway health probe failed',
    };
  }
}

function evaluateLocalGatewayCredentialMatch(
  params: { gatewayUrl: string; token?: string; password?: string },
  gatewayTarget: { hostname: string; port: number | null } | null,
): boolean | null {
  const localConfig = readLocalGatewayRuntimeConfig();
  if (!localConfig) return null;

  if (
    gatewayTarget?.port != null
    && localConfig.port != null
    && gatewayTarget.port !== localConfig.port
  ) {
    return null;
  }

  if (!localConfig.token && !localConfig.password) {
    return true;
  }

  const tokenMatches = !localConfig.token || normalizeCliText(params.token) === localConfig.token;
  const passwordMatches = !localConfig.password || normalizeCliText(params.password) === localConfig.password;
  return tokenMatches && passwordMatches;
}

function readCliErrorDetail(error: any): string {
  return [
    normalizeCliText(error?.stderr),
    normalizeCliText(error?.stdout),
    normalizeCliText(error?.message),
  ].find(Boolean) || '';
}

function normalizeFallbackMode(value: unknown): 'inherit' | 'custom' | 'disabled' | undefined {
  return value === 'inherit' || value === 'custom' || value === 'disabled' ? value : undefined;
}

function normalizeFallbackList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function getOpenClawConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function getExecApprovalsPath() {
  return path.join(os.homedir(), '.openclaw', 'exec-approvals.json');
}

function isExecutableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

let cachedOpenClawExecutablePath: string | null = null;
let openClawCliRepairInFlight: Promise<string> | null = null;
let gatewayRestartTask: Promise<void> | null = null;
let gatewayRestartQueued = false;
let browserTaskSnapshot: BrowserTaskSnapshot = {
  status: 'idle',
  phase: null,
  rawDetail: null,
  updatedAt: null,
};

function getBrowserTaskSnapshot(): BrowserTaskSnapshot {
  return { ...browserTaskSnapshot };
}

function updateBrowserTaskSnapshot(patch: Partial<Omit<BrowserTaskSnapshot, 'updatedAt'>>) {
  browserTaskSnapshot = {
    ...browserTaskSnapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function resetBrowserTaskSnapshot() {
  browserTaskSnapshot = {
    status: 'idle',
    phase: null,
    rawDetail: null,
    updatedAt: new Date().toISOString(),
  };
}

function ensureBrowserTaskIdle() {
  if (browserTaskSnapshot.status !== 'idle') {
    throw new StructuredRequestError(409, BROWSER_TASK_BUSY_ERROR_CODE, 'Another browser task is already running.');
  }
}

function collectOpenClawPackageRoots() {
  const moduleBaseDirs = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();

  const pushRoot = (candidate: string) => {
    const normalized = normalizeCliText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  };

  for (const moduleBaseDir of moduleBaseDirs) {
    pushRoot(path.join(moduleBaseDir, 'openclaw'));
    try {
      const stagedRoots = fs.readdirSync(moduleBaseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\.openclaw-/i.test(entry.name))
        .map((entry) => {
          const fullPath = path.join(moduleBaseDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {}
          return { fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const stagedRoot of stagedRoots) {
        pushRoot(stagedRoot.fullPath);
      }
    } catch {}
  }

  const globalBinPath = path.join(os.homedir(), '.npm-global', 'bin', process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  try {
    const resolvedFromBin = fs.realpathSync(globalBinPath);
    pushRoot(path.dirname(resolvedFromBin));
  } catch {}

  return roots;
}

function collectOpenClawPackageEntryCandidates() {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: string | null | undefined) => {
    const normalized = normalizeCliText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
          bin?: string | Record<string, string>;
        };
        if (typeof packageJson.bin === 'string') {
          pushCandidate(path.join(packageRoot, packageJson.bin));
        } else if (packageJson.bin && typeof packageJson.bin === 'object' && typeof packageJson.bin.openclaw === 'string') {
          pushCandidate(path.join(packageRoot, packageJson.bin.openclaw));
        }
      }
    } catch {}

    pushCandidate(path.join(packageRoot, 'openclaw.mjs'));
  }

  return candidates;
}

function findShellResolvedOpenClawCommandPath() {
  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const seen = new Set<string>();
  const pathEntries = normalizeCliText(process.env.PATH)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, executableName);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPreferredOpenClawShellEntrypointPath() {
  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const preferredDirs = [
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
  ];
  const pathEntries = normalizeCliText(process.env.PATH)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const preferredDir of preferredDirs) {
    if (pathEntries.includes(preferredDir)) {
      return path.join(preferredDir, executableName);
    }
  }

  return path.join(preferredDirs[0], executableName);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildOpenClawShellWrapperScript(resolvedExecutablePath: string) {
  const preferredCandidates = [
    normalizeCliText(resolvedExecutablePath),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules', 'openclaw', 'openclaw.mjs'),
  ].filter(Boolean);
  const preferredCandidateLines = preferredCandidates
    .map((candidate) => `  ${shellQuote(candidate)}`)
    .join('\n');
  const stagedBaseDirLines = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
  ].map((candidate) => `  ${shellQuote(candidate)}`).join('\n');

  return `#!/usr/bin/env bash
set -euo pipefail

preferred_candidates=(
${preferredCandidateLines}
)

staged_base_dirs=(
${stagedBaseDirLines}
)

for candidate in "\${preferred_candidates[@]}"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

for base_dir in "\${staged_base_dirs[@]}"; do
  if [ ! -d "$base_dir" ]; then
    continue
  fi

  while IFS= read -r candidate; do
    if [ -x "$candidate" ]; then
      exec "$candidate" "$@"
    fi
  done < <(ls -dt "$base_dir"/.openclaw-*/openclaw.mjs 2>/dev/null || true)
done

echo "OpenClaw CLI not found." >&2
exit 127
`;
}

async function canExecuteOpenClawCommand(filePath: string) {
  try {
    await execFilePromise(filePath, ['--version'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureOpenClawShellEntrypoint(resolvedExecutablePath: string) {
  if (process.platform === 'win32') {
    return null;
  }

  const shellResolvedPath = findShellResolvedOpenClawCommandPath();
  if (shellResolvedPath && await canExecuteOpenClawCommand(shellResolvedPath)) {
    return shellResolvedPath;
  }

  const shellEntrypointPath = getPreferredOpenClawShellEntrypointPath();
  fs.mkdirSync(path.dirname(shellEntrypointPath), { recursive: true });
  fs.rmSync(shellEntrypointPath, { force: true });
  fs.writeFileSync(shellEntrypointPath, buildOpenClawShellWrapperScript(resolvedExecutablePath), { mode: 0o755 });
  fs.chmodSync(shellEntrypointPath, 0o755);

  if (!await canExecuteOpenClawCommand(shellEntrypointPath)) {
    throw new Error(`Failed to repair the OpenClaw shell entrypoint at ${shellEntrypointPath}.`);
  }

  cachedOpenClawExecutablePath = shellEntrypointPath;
  return shellEntrypointPath;
}

async function readOpenClawGatewayServiceVersion() {
  try {
    const { stdout } = await execFilePromise('systemctl', ['--user', 'show', 'openclaw-gateway.service', '-p', 'Description', '--value'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const description = normalizeCliText(stdout);
    const matched = description.match(/v?(\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
    return matched?.[1] || null;
  } catch {
    return null;
  }
}

async function repairBrokenOpenClawCliInstall(preferredVersion?: string | null) {
  if (openClawCliRepairInFlight) {
    return openClawCliRepairInFlight;
  }

  openClawCliRepairInFlight = (async () => {
    const gatewayReportedVersion = await readOpenClawGatewayServiceVersion();
    const targetVersion = normalizeCliText(preferredVersion) || gatewayReportedVersion || 'latest';
    const packageSpec = targetVersion === 'latest' ? 'openclaw@latest' : `openclaw@${targetVersion}`;

    cachedOpenClawExecutablePath = null;
    await execFilePromise('npm', ['install', '-g', packageSpec], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 20,
      env: process.env,
    });

    cachedOpenClawExecutablePath = null;
    const resolvedExecutablePath = getOpenClawExecutablePath();
    await ensureOpenClawShellEntrypoint(resolvedExecutablePath);
    return cachedOpenClawExecutablePath || resolvedExecutablePath;
  })();

  try {
    return await openClawCliRepairInFlight;
  } finally {
    openClawCliRepairInFlight = null;
  }
}

async function ensureResolvedOpenClawExecutablePath(preferredRepairVersion?: string | null) {
  try {
    return getOpenClawExecutablePath();
  } catch {
    return repairBrokenOpenClawCliInstall(preferredRepairVersion);
  }
}

function getOpenClawExecutablePath() {
  if (cachedOpenClawExecutablePath && isExecutableFile(cachedOpenClawExecutablePath)) {
    return cachedOpenClawExecutablePath;
  }

  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const candidates = [
    normalizeCliText(process.env.OPENCLAW_BIN),
    ...normalizeCliText(process.env.PATH)
      .split(path.delimiter)
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => path.join(entry, executableName)),
    path.join(os.homedir(), '.npm-global', 'bin', executableName),
    path.join(os.homedir(), '.local', 'bin', executableName),
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    ...collectOpenClawPackageEntryCandidates(),
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      cachedOpenClawExecutablePath = candidate;
      return candidate;
    }
  }

  throw new Error(
    `OpenClaw CLI not found. Checked: ${Array.from(seen).join(', ')}`
  );
}

async function readOpenClawVersion() {
  try {
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    const { stdout } = await execFilePromise(executablePath, ['--version']);
    const raw = normalizeCliText(stdout);
    const matched = raw.match(/OpenClaw\s+([^\s(]+)/i);
    return matched?.[1] || raw || null;
  } catch {
    return null;
  }
}

async function probeGatewayConnectionStatus(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}, options?: {
  requireAuth?: boolean;
}): Promise<{ connected: boolean; message?: string; source: 'local-runtime' | 'auth-probe' }> {
  const gatewayTarget = parseGatewayUrlForStatusProbe(params.gatewayUrl);

  if (gatewayTarget && isLoopbackHostname(gatewayTarget.hostname)) {
    const health = await probeGatewayHealth(params.gatewayUrl);
    if (!health.ok) {
      return {
        connected: false,
        message: health.message || 'Local OpenClaw gateway is not responding',
        source: 'local-runtime',
      };
    }

    const credentialMatches = evaluateLocalGatewayCredentialMatch(params, gatewayTarget);
    if (credentialMatches === true) {
      return {
        connected: true,
        message: 'Local OpenClaw gateway runtime healthy',
        source: 'local-runtime',
      };
    }

    if (credentialMatches === false) {
      return {
        connected: false,
        message: 'Gateway credentials do not match local OpenClaw config',
        source: 'local-runtime',
      };
    }

    if (!options?.requireAuth) {
      return {
        connected: true,
        message: 'Local OpenClaw gateway runtime healthy',
        source: 'local-runtime',
      };
    }
  }

  const client = new OpenClawClient({
    gatewayUrl: params.gatewayUrl,
    token: params.token,
    password: params.password,
  });
  client.on('error', () => {});
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Gateway connect probe timeout')), 3000);
      }),
    ]);
    return { connected: true, source: 'auth-probe' };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    client.disconnect();
  }
}

function readOpenClawConfig(): any | null {
  try {
    const configPath = getOpenClawConfigPath();
    if (!fs.existsSync(configPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return null;
  }
}

function writeOpenClawConfig(config: any) {
  const configPath = getOpenClawConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function isMaxPermissionsConfigEnabled(config: any): boolean {
  return !config?.tools?.profile && config?.tools?.exec?.security === 'full';
}

function readMaxPermissionsEnabled(): boolean | null {
  try {
    const config = readOpenClawConfig();
    if (!config) {
      return null;
    }
    return isMaxPermissionsConfigEnabled(config);
  } catch (error) {
    return null;
  }
}

function normalizeConfiguredBrowserProfile(config: any): string {
  return normalizeCliText(config?.browser?.defaultProfile)
    || normalizeCliText(config?.browser?.profile)
    || BROWSER_HEALTH_PROFILE;
}

function readBrowserConfigState(): BrowserConfigState {
  const config = readOpenClawConfig();
  const profile = normalizeConfiguredBrowserProfile(config);
  const profileConfig = config?.browser?.profiles?.[profile];
  const configuredCdpPort = profileConfig?.cdpPort ?? config?.browser?.cdpPort;

  return {
    enabled: typeof config?.browser?.enabled === 'boolean' ? config.browser.enabled : null,
    headless: typeof config?.browser?.headless === 'boolean' ? config.browser.headless : null,
    profile,
    executablePath: normalizeCliText(config?.browser?.executablePath) || null,
    noSandbox: typeof config?.browser?.noSandbox === 'boolean' ? config.browser.noSandbox : null,
    attachOnly: typeof config?.browser?.attachOnly === 'boolean' ? config.browser.attachOnly : null,
    cdpPort: Number.isFinite(configuredCdpPort) ? Number(configuredCdpPort) : null,
  };
}

function readBrowserHeadedModeConfig(): BrowserHeadedModeConfig {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const headless = config?.browser?.headless === true;

  return {
    headless,
    headedModeEnabled: !headless,
  };
}

function setBrowserHeadedModeEnabled(headedModeEnabled: boolean): BrowserHeadedModeConfig {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.browser || typeof config.browser !== 'object') {
    config.browser = {};
  }
  config.browser.headless = !headedModeEnabled;
  writeOpenClawConfig(config);

  return {
    headless: config.browser.headless === true,
    headedModeEnabled: config.browser.headless !== true,
  };
}

function buildFallbackBrowserHealthDiagnostics(
  checkedAt = Date.now(),
  rawDetail?: string | null
): BrowserHealthDiagnostics {
  const browserConfig = readBrowserConfigState();

  return {
    checkedAt,
    maxPermissionsEnabled: readMaxPermissionsEnabled(),
    profile: browserConfig.profile,
    enabled: browserConfig.enabled,
    running: null,
    transport: null,
    chosenBrowser: null,
    detectedBrowser: null,
    headless: null,
    detectError: null,
    rawDetail: normalizeCliText(rawDetail) || null,
    config: browserConfig,
    runtime: null,
  };
}

function resolveBrowserValidationFailureIssue(detail: string, diagnostics: BrowserHealthDiagnostics): BrowserHealthIssue {
  if (diagnostics.enabled === false || /browser control is disabled/i.test(detail)) {
    return 'disabled';
  }
  if (diagnostics.detectError) {
    return 'detect-error';
  }
  if (/executablepath not found|attachonly|no chrome tabs found/i.test(detail)) {
    return 'detect-error';
  }
  if (diagnostics.running === false) {
    return 'stopped';
  }
  if (/timed out|timeout/i.test(detail)) {
    return 'timeout';
  }
  return 'unknown';
}

function finalizeBrowserHealthSnapshot(
  snapshot: BrowserHealthDiagnostics & {
    issue?: BrowserHealthIssue | null;
    validationSucceeded?: boolean | null;
    validationDetail?: string | null;
  }
): BrowserHealthSnapshot {
  let issue = snapshot.issue ?? null;
  const validationSucceeded = typeof snapshot.validationSucceeded === 'boolean'
    ? snapshot.validationSucceeded
    : null;
  const validationDetail = normalizeCliText(snapshot.validationDetail) || null;

  if (!issue) {
    if (snapshot.maxPermissionsEnabled === false) {
      issue = 'permissions';
    } else if (snapshot.enabled === false) {
      issue = 'disabled';
    } else if (validationSucceeded === false) {
      issue = resolveBrowserValidationFailureIssue(validationDetail || snapshot.rawDetail || '', snapshot);
    } else if (validationSucceeded !== true) {
      if (snapshot.running === false) issue = 'stopped';
      else if (snapshot.detectError) issue = 'detect-error';
      else issue = 'unknown';
    }
  }

  const fallbackDetail = normalizeCliText(snapshot.rawDetail) || null;
  const rawDetail = validationSucceeded === false
    ? validationDetail
    : issue === null
      ? null
      : fallbackDetail;

  return {
    ...snapshot,
    healthy: issue === null && validationSucceeded === true,
    issue,
    rawDetail,
    validationSucceeded,
    validationDetail,
  };
}

function buildBrowserHealthDiagnosticsFromCli(
  raw: any,
  checkedAt = Date.now(),
  browserConfig = readBrowserConfigState(),
  rawDetail?: string | null
): BrowserHealthDiagnostics {
  const maxPermissionsEnabled = readMaxPermissionsEnabled();
  const enabled = browserConfig.enabled;
  const running = typeof raw?.running === 'boolean' ? raw.running : null;
  const headless = typeof raw?.headless === 'boolean' ? raw.headless : null;
  const detectError = normalizeCliText(raw?.detectError) || null;
  const runtime: BrowserRuntimeState = {
    profile: normalizeCliText(raw?.profile) || browserConfig.profile,
    running,
    transport: normalizeCliText(raw?.transport) || null,
    chosenBrowser: normalizeCliText(raw?.chosenBrowser) || null,
    detectedBrowser: normalizeCliText(raw?.detectedBrowser) || null,
    headless,
    detectError,
  };

  return {
    checkedAt,
    maxPermissionsEnabled,
    profile: runtime.profile || browserConfig.profile,
    enabled,
    running,
    transport: runtime.transport,
    chosenBrowser: runtime.chosenBrowser,
    detectedBrowser: runtime.detectedBrowser,
    headless,
    detectError,
    rawDetail: normalizeCliText(rawDetail) || null,
    config: browserConfig,
    runtime,
  };
}

function patchExecApprovals(enabled: boolean) {
  const execApprovalsPath = getExecApprovalsPath();
  if (!fs.existsSync(execApprovalsPath)) {
    return;
  }

  const approvals = JSON.parse(fs.readFileSync(execApprovalsPath, 'utf-8'));
  if (!approvals.defaults) approvals.defaults = {};

  if (enabled) {
    approvals.defaults.ask = 'off';
    approvals.defaults.security = 'full';
    approvals.agents = { '*': { allowlist: [{ pattern: '*' }] } };
  } else {
    delete approvals.defaults.ask;
    delete approvals.defaults.security;
    delete approvals.agents;
  }

  fs.writeFileSync(execApprovalsPath, JSON.stringify(approvals, null, 2));
}

function setMaxPermissionsEnabled(enabled: boolean) {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (enabled) {
    config.tools = MAX_PERMISSIONS_TOOLS;

    if (!config.commands) config.commands = {};
    config.commands.bash = true;
    config.commands.restart = true;
    config.commands.native = 'auto';
    config.commands.nativeSkills = 'auto';

    if (!config.browser) config.browser = {};
    config.browser.enabled = true;
    delete config.browser.ssrfPolicy;
  } else {
    config.tools = { profile: 'coding' };
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.sandbox) config.agents.defaults.sandbox = {};
  config.agents.defaults.sandbox.mode = 'off';

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  patchExecApprovals(enabled);

  return { enabled };
}

async function runOpenClawBrowserCommand(args: string[], timeoutMs: number) {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  return execFilePromise(executablePath, ['browser', ...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

function buildBrowserProfileArgs(browserConfig: BrowserConfigState, args: string[]) {
  return ['--browser-profile', browserConfig.profile || BROWSER_HEALTH_PROFILE, ...args];
}

function isExampleDomainSnapshot(snapshotText: string) {
  return normalizeCliText(snapshotText).includes('Example Domain');
}

function isCertificateInterstitialSnapshot(snapshotText: string) {
  const normalized = normalizeCliText(snapshotText);
  return /ERR_CERT_/i.test(normalized)
    || normalized.includes('您的连接不是私密连接')
    || normalized.includes('Your connection is not private');
}

function readConfiguredBrowserValidationError(browserConfig: BrowserConfigState): string | null {
  if (browserConfig.enabled === false) {
    return 'browser.enabled is false';
  }

  if (browserConfig.executablePath) {
    try {
      const stat = fs.statSync(browserConfig.executablePath);
      if (!stat.isFile()) {
        return `browser.executablePath not found: ${browserConfig.executablePath}`;
      }
      fs.accessSync(browserConfig.executablePath, fs.constants.X_OK);
    } catch {
      return `browser.executablePath not found: ${browserConfig.executablePath}`;
    }
  }

  return null;
}

async function stopOpenClawBrowserBestEffort() {
  try {
    const browserConfig = readBrowserConfigState();
    await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_SELF_HEAL_STOP_TIMEOUT_MS), 'stop']),
      BROWSER_SELF_HEAL_STOP_TIMEOUT_MS + 3000
    );
  } catch (error) {
    // Browser may already be stopped or the CLI may time out; self-heal should continue.
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type BrowserTaskProgressReporter = (phase: string, rawDetail?: string | null) => void;

type BrowserRuntimeReadiness = {
  ready: boolean;
  terminalFailure: boolean;
  diagnostics: BrowserHealthDiagnostics;
  detail: string | null;
};

async function runBrowserRuntimeReadinessCheck(reportProgress?: BrowserTaskProgressReporter): Promise<BrowserRuntimeReadiness> {
  reportProgress?.('read-config');
  const checkedAt = Date.now();
  const browserConfig = readBrowserConfigState();
  const configError = readConfiguredBrowserValidationError(browserConfig);

  if (configError && browserConfig.enabled === false) {
    return {
      ready: false,
      terminalFailure: true,
      diagnostics: buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
      detail: null,
    };
  }

  if (configError) {
    return {
      ready: false,
      terminalFailure: true,
      diagnostics: buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
      detail: configError,
    };
  }

  reportProgress?.('read-status');
  let diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
  if (diagnostics.running === true && !diagnostics.detectError) {
    return {
      ready: true,
      terminalFailure: false,
      diagnostics,
      detail: null,
    };
  }

  try {
    reportProgress?.('start-browser');
    await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_START_TIMEOUT_MS), 'start']),
      BROWSER_HEALTH_START_TIMEOUT_MS
    );

    reportProgress?.('wait-running');
    diagnostics = await waitForBrowserRunning(browserConfig, checkedAt);
    if (diagnostics.running !== true) {
      return {
        ready: false,
        terminalFailure: false,
        diagnostics,
        detail: 'Browser runtime did not become healthy after start.',
      };
    }

    return {
      ready: true,
      terminalFailure: false,
      diagnostics,
      detail: null,
    };
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Browser health check failed';
    diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt, detail);
    return {
      ready: false,
      terminalFailure: false,
      diagnostics,
      detail,
    };
  }
}

async function waitForBrowserHealth(timeoutMs: number, reportProgress?: BrowserTaskProgressReporter) {
  const deadline = Date.now() + timeoutMs;
  let terminalFailure = false;

  while (Date.now() < deadline) {
    const readiness = await runBrowserRuntimeReadinessCheck(reportProgress);
    if (readiness.ready) {
      return runBrowserHealthCheck(reportProgress);
    }
    terminalFailure = readiness.terminalFailure;
    if (terminalFailure) break;
    await sleep(BROWSER_SELF_HEAL_POLL_INTERVAL_MS);
  }

  return runBrowserHealthCheck(reportProgress);
}

async function readBrowserHealthDiagnostics(
  browserConfig = readBrowserConfigState(),
  checkedAt = Date.now(),
  rawDetail?: string | null
): Promise<BrowserHealthDiagnostics> {
  try {
    const { stdout } = await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--json', '--timeout', String(BROWSER_HEALTH_CLI_TIMEOUT_MS), 'status']),
      BROWSER_HEALTH_EXEC_TIMEOUT_MS
    );
    const parsed = JSON.parse(normalizeCliText(stdout) || '{}');
    return buildBrowserHealthDiagnosticsFromCli(parsed, checkedAt, browserConfig, rawDetail);
  } catch (error: any) {
    const stdout = normalizeCliText(error?.stdout);
    if (stdout) {
      try {
        return buildBrowserHealthDiagnosticsFromCli(JSON.parse(stdout), checkedAt, browserConfig, rawDetail || readCliErrorDetail(error));
      } catch {}
    }

    return buildFallbackBrowserHealthDiagnostics(checkedAt, rawDetail || readCliErrorDetail(error));
  }
}

async function waitForBrowserRunning(browserConfig: BrowserConfigState, checkedAt: number) {
  let diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (diagnostics.running === true) {
      return diagnostics;
    }
    await sleep(2000);
    diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
  }
  return diagnostics;
}

async function readBrowserSnapshot(browserConfig: BrowserConfigState) {
  const { stdout } = await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_OPEN_TIMEOUT_MS), 'snapshot']),
    BROWSER_HEALTH_SNAPSHOT_TIMEOUT_MS
  );
  return normalizeCliText(stdout);
}

async function captureExampleDomainSnapshot(browserConfig: BrowserConfigState) {
  let lastSnapshot = '';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastSnapshot = await readBrowserSnapshot(browserConfig);
    if (isExampleDomainSnapshot(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(2000);
  }

  const error = new Error(`Browser snapshot did not capture the Example Domain page. Last snapshot: ${lastSnapshot || 'empty'}`);
  (error as Error & { snapshotText?: string }).snapshotText = lastSnapshot;
  throw error;
}

async function openBrowserValidationUrl(browserConfig: BrowserConfigState, url: string) {
  const { stdout } = await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_OPEN_TIMEOUT_MS), 'open', url]),
    BROWSER_HEALTH_OPEN_TIMEOUT_MS
  );

  if (!/opened:/i.test(normalizeCliText(stdout))) {
    throw new Error(`Browser open command did not confirm navigation to ${url}.`);
  }
}

async function runBrowserHealthCheck(reportProgress?: BrowserTaskProgressReporter): Promise<BrowserHealthSnapshot> {
  reportProgress?.('read-config');
  const checkedAt = Date.now();
  const browserConfig = readBrowserConfigState();
  const configError = readConfiguredBrowserValidationError(browserConfig);

  if (configError && browserConfig.enabled === false) {
    return finalizeBrowserHealthSnapshot({
      ...buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
      validationSucceeded: null,
      validationDetail: null,
    });
  }

  if (configError) {
    return finalizeBrowserHealthSnapshot({
      ...buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
      validationSucceeded: false,
      validationDetail: configError,
    });
  }

  reportProgress?.('read-status');
  let diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);

  try {
    reportProgress?.('start-browser');
    await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_START_TIMEOUT_MS), 'start']),
      BROWSER_HEALTH_START_TIMEOUT_MS
    );

    reportProgress?.('wait-running');
    diagnostics = await waitForBrowserRunning(browserConfig, checkedAt);
    if (diagnostics.running !== true) {
      throw new Error('Browser runtime did not become healthy after start.');
    }

    reportProgress?.('open-validation');
    await openBrowserValidationUrl(browserConfig, BROWSER_HEALTH_VALIDATION_URL);

    try {
      reportProgress?.('capture-snapshot');
      await captureExampleDomainSnapshot(browserConfig);
    } catch (error: any) {
      const snapshotText = normalizeCliText(error?.snapshotText);
      if (!isCertificateInterstitialSnapshot(snapshotText)) {
        throw error;
      }

      reportProgress?.('open-validation');
      await openBrowserValidationUrl(browserConfig, BROWSER_HEALTH_FALLBACK_VALIDATION_URL);
      reportProgress?.('capture-snapshot');
      await captureExampleDomainSnapshot(browserConfig);
    }

    reportProgress?.('finalize');
    diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);

    return finalizeBrowserHealthSnapshot({
      ...diagnostics,
      validationSucceeded: true,
      validationDetail: null,
    });
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Browser health check failed';
    reportProgress?.('finalize', detail);
    diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt, detail);

    return finalizeBrowserHealthSnapshot({
      ...diagnostics,
      validationSucceeded: false,
      validationDetail: detail,
    });
  }
}

async function restartGatewayService() {
  for (const [sessionId, client] of connections.entries()) {
    try {
      client.disconnect();
    } catch (err) {
      console.error(`Error disconnecting client ${sessionId}:`, err);
    }
  }
  connections.clear();
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  await execFilePromise(executablePath, ['gateway', 'restart']);
}

function scheduleGatewayRestart() {
  gatewayRestartQueued = true;
  if (gatewayRestartTask) {
    return gatewayRestartTask;
  }

  gatewayRestartTask = (async () => {
    while (gatewayRestartQueued) {
      gatewayRestartQueued = false;
      await restartGatewayService();
    }
  })().finally(() => {
    gatewayRestartTask = null;
  });

  return gatewayRestartTask;
}

function buildUpdateCommand(targetPort: string) {
  return `set -o pipefail; curl -fsSL ${JSON.stringify(UPDATE_SCRIPT_URL)} | bash -s -- ${JSON.stringify(targetPort)}`;
}

async function startUpdateTask() {
  if (activeUpdateProcess || ['checking', 'updating', 'stopping', 'restarting'].includes(updateSnapshot.status)) {
    throw new StructuredRequestError(409, UPDATE_ALREADY_RUNNING_ERROR_CODE, 'An update task is already running.');
  }

  patchUpdateSnapshot({
    status: 'checking',
    phase: null,
    canCancel: false,
    message: 'Checking for updates.',
    rawDetail: null,
    logs: [],
    startedAt: new Date().toISOString(),
    currentVersion: getCurrentAppVersionInfo().version,
    latestVersion: null,
  });

  const latestInfo = await getLatestVersionInfo();
  rememberLatestVersionInfo(latestInfo);
  if (!latestInfo.hasUpdate || !latestInfo.latestVersion) {
    resetUpdateSnapshot();
    throw new StructuredRequestError(409, UPDATE_NO_NEW_VERSION_ERROR_CODE, 'No newer version is available.');
  }

  const startCommit = await readGitHeadCommit();
  const targetPort = getCurrentClawUiPort();
  const child = spawn('/bin/bash', ['-lc', buildUpdateCommand(targetPort)], {
    cwd: appRepoRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAWUI_SKIP_SERVICE_RESTART: '1',
    },
  });

  activeUpdateProcess = {
    child,
    startCommit,
    cancelRequested: false,
    cancelTimer: null,
  };

  patchUpdateSnapshot({
    status: 'updating',
    phase: 'downloading-script',
    canCancel: true,
    currentVersion: latestInfo.currentVersion || getCurrentAppVersionInfo().version,
    latestVersion: latestInfo.latestVersion,
    message: getUpdatePhaseMessage('downloading-script'),
    rawDetail: null,
  });
  appendUpdateLog(`Starting update to ${latestInfo.latestVersion}.`);

  attachUpdateOutput(child.stdout, 'stdout');
  attachUpdateOutput(child.stderr, 'stderr');

  child.once('error', (error) => {
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    patchUpdateSnapshot({
      status: 'update_failed',
      canCancel: false,
      message: 'Update failed.',
      rawDetail: detail,
    });
    appendUpdateLog(`Update process failed to start: ${detail}`);
    activeUpdateProcess = null;
  });

  child.once('close', async (code, signal) => {
    const activeProcess = activeUpdateProcess;
    activeUpdateProcess = null;
    if (activeProcess?.cancelTimer) {
      clearTimeout(activeProcess.cancelTimer);
    }

    if (activeProcess?.cancelRequested) {
      try {
        await revertUpdateWorkspace(activeProcess.startCommit);
        resetUpdateSnapshot();
        appendUpdateLog('Update cancelled and workspace restored to the previous version.');
      } catch (error) {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        patchUpdateSnapshot({
          status: 'update_failed',
          canCancel: false,
          message: 'Update cancel cleanup failed.',
          rawDetail: detail,
        });
        appendUpdateLog(`Failed to restore workspace after cancel: ${detail}`);
      }
      rememberLatestVersionInfo(null);
      return;
    }

    if (code === 0) {
      patchUpdateSnapshot({
        status: 'update_succeeded',
        phase: 'complete',
        canCancel: false,
        currentVersion: getCurrentAppVersionInfo().version,
        latestVersion: latestInfo.latestVersion,
        message: 'Update completed. Restart the service to apply the new build.',
        rawDetail: null,
      });
      appendUpdateLog('Update completed successfully. Waiting for service restart.');
      return;
    }

    const detail = updateSnapshot.rawDetail
      || `Update exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
    patchUpdateSnapshot({
      status: 'update_failed',
      canCancel: false,
      message: 'Update failed.',
      rawDetail: detail,
    });
    appendUpdateLog(`Update failed: ${detail}`);
  });

  return buildUpdateStatusResponse();
}

async function cancelUpdateTask() {
  if (!activeUpdateProcess || !['updating', 'checking', 'stopping'].includes(updateSnapshot.status)) {
    throw new StructuredRequestError(409, UPDATE_NOT_RUNNING_ERROR_CODE, 'There is no running update task to stop.');
  }

  if (updateSnapshot.status === 'stopping') {
    return buildUpdateStatusResponse();
  }

  if (!updateSnapshot.canCancel || !updateSnapshot.phase || !UPDATE_CANCELLABLE_PHASES.has(updateSnapshot.phase)) {
    throw new StructuredRequestError(409, UPDATE_CANNOT_CANCEL_PHASE_ERROR_CODE, `The current phase (${updateSnapshot.phase || 'unknown'}) cannot be stopped safely.`);
  }

  patchUpdateSnapshot({
    status: 'stopping',
    canCancel: false,
    message: 'Stopping update task.',
  });
  appendUpdateLog('Stopping update task on user request.');

  activeUpdateProcess.cancelRequested = true;
  try {
    process.kill(-activeUpdateProcess.child.pid!, 'SIGTERM');
  } catch (error) {
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    patchUpdateSnapshot({
      status: 'update_failed',
      canCancel: false,
      message: 'Failed to stop update task.',
      rawDetail: detail,
    });
    throw new StructuredRequestError(500, UPDATE_CANCEL_FAILED_ERROR_CODE, detail);
  }

  activeUpdateProcess.cancelTimer = setTimeout(() => {
    try {
      if (activeUpdateProcess?.cancelRequested) {
        process.kill(-activeUpdateProcess.child.pid!, 'SIGKILL');
      }
    } catch {}
  }, UPDATE_CANCEL_KILL_TIMEOUT_MS);

  return buildUpdateStatusResponse();
}

async function resetUpdateTaskState() {
  if (activeUpdateProcess) {
    throw new StructuredRequestError(409, UPDATE_ALREADY_RUNNING_ERROR_CODE, 'Cannot reset while an update task is running.');
  }
  rememberLatestVersionInfo(null);
  resetUpdateSnapshot();
  return buildUpdateStatusResponse();
}

async function restartClawUiService() {
  if (updateSnapshot.status !== 'update_succeeded') {
    throw new StructuredRequestError(409, UPDATE_RESTART_NOT_READY_ERROR_CODE, 'Service restart is only available after a successful update.');
  }

  const serviceName = resolveClawUiServiceName();
  await execFilePromise('systemctl', ['--user', 'show', serviceName, '--property', 'LoadState'], {
    maxBuffer: 1024 * 1024,
  });

  patchUpdateSnapshot({
    status: 'restarting',
    canCancel: false,
    serviceName,
    message: `Restarting ${serviceName}.`,
    rawDetail: null,
  });
  appendUpdateLog(`Scheduling restart for ${serviceName}.`);

  setTimeout(() => {
    execFilePromise('systemctl', ['--user', 'restart', serviceName, '--no-block'], {
      maxBuffer: 1024 * 1024,
    }).catch((error) => {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      patchUpdateSnapshot({
        status: 'restart_failed',
        canCancel: false,
        serviceName,
        message: `Failed to restart ${serviceName}.`,
        rawDetail: detail,
      });
      appendUpdateLog(`Restart failed: ${detail}`);
    });
  }, UPDATE_RESTART_DELAY_MS);

  return buildUpdateStatusResponse();
}

function createStructuredChatError(rawDetail?: string | null, forcedCode?: string) {
  const detail = typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.trim() : 'Unknown error';
  const messageCode = forcedCode || (detail === CHAT_GATEWAY_DISCONNECTED_DETAIL ? CHAT_GATEWAY_DISCONNECTED_CODE : CHAT_RUN_ERROR_CODE);

  return {
    content: `${CHAT_RUN_ERROR_PREFIX}${detail}`,
    messageCode,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

function buildStructuredChatHttpError(rawDetail?: string | null, forcedCode?: string) {
  const structured = createStructuredChatError(rawDetail, forcedCode);
  return {
    success: false as const,
    message: structured.content,
    error: structured.content,
    messageCode: structured.messageCode,
    messageParams: structured.messageParams || null,
    rawDetail: structured.rawDetail,
    role: structured.role,
  };
}

function getStructuredChatMessage(content?: string | null) {
  if (!content || !content.startsWith(CHAT_RUN_ERROR_PREFIX)) return {};

  const detail = content.slice(CHAT_RUN_ERROR_PREFIX.length).trim();
  if (!detail) return {};

  return {
    messageCode: detail === CHAT_GATEWAY_DISCONNECTED_DETAIL ? CHAT_GATEWAY_DISCONNECTED_CODE : CHAT_RUN_ERROR_CODE,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

function withStructuredGroupMessage<T extends { content?: string | null; messageCode?: string; messageParams?: StructuredMessageParams | null; rawDetail?: string | null; sender_id?: string | null; sender_name?: string | null }>(
  message: T,
  options?: { groupId?: string | null }
): T & { messageCode?: string; messageParams?: StructuredMessageParams; rawDetail?: string | null; sender_id?: string | null; sender_name?: string | null } {
  const content = typeof message.content === 'string'
    ? rewriteOpenClawMediaPaths(message.content, options?.groupId ? getGroupWorkspacePath(options.groupId) : undefined)
    : message.content;
  const structured = getStructuredGroupMessage(content);
  return {
    ...message,
    content,
    messageCode: message.messageCode ?? structured.messageCode,
    messageParams: message.messageParams ?? structured.messageParams,
    rawDetail: message.rawDetail ?? structured.rawDetail,
    sender_id: structured.forceSystemMessage ? 'system' : (message.sender_id ?? null),
    sender_name: structured.forceSystemMessage ? '系统' : (message.sender_name ?? null),
  };
}

function withStructuredChatMessage<T extends { content?: string | null; role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams | null; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null }>(
  message: T,
  options?: { sessionId?: string | null }
): T & { role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null } {
  const content = typeof message.content === 'string'
    ? rewriteOpenClawMediaPaths(message.content, options?.sessionId ? getSessionWorkspacePath(options.sessionId) : undefined)
    : message.content;
  const structured = getStructuredChatMessage(content);
  return {
    ...message,
    content,
    role: structured.role ?? message.role,
    messageCode: message.messageCode ?? structured.messageCode,
    messageParams: message.messageParams ?? structured.messageParams,
    rawDetail: message.rawDetail ?? structured.rawDetail,
    agent_id: structured.agent_id ?? (message.agent_id ?? null),
    agent_name: structured.agent_name ?? (message.agent_name ?? null),
  };
}

function resolveGroupMemberDisplayName(member: { agent_id: string; display_name: string }): string {
  const linkedSession = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
  const latestName = linkedSession?.name?.trim();
  return latestName || member.display_name;
}

function withResolvedGroupMemberDisplayName<T extends { agent_id: string; display_name: string }>(member: T): T {
  const latestName = resolveGroupMemberDisplayName(member);
  return latestName === member.display_name ? member : { ...member, display_name: latestName };
}

function parsePositiveIntegerQueryParam(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getHistoryPageQueryParams(query: Record<string, unknown>) {
  const beforeId = parsePositiveIntegerQueryParam(query.beforeId);
  const requestedLimit = parsePositiveIntegerQueryParam(query.limit);
  const limit = Math.min(requestedLimit ?? DEFAULT_HISTORY_PAGE_LIMIT, MAX_HISTORY_PAGE_LIMIT);
  return { beforeId, limit };
}

function buildHistoryPageResponse<T>(rows: T[], pageInfo: MessagePageInfo) {
  return {
    success: true as const,
    messages: rows,
    pageInfo,
  };
}

function buildHistorySearchResponse(matches: MessageSearchMatch[]) {
  return {
    success: true as const,
    matches: matches.map((match) => ({
      messageId: String(match.id),
      anchorBeforeId: match.anchorBeforeId ?? null,
    })),
  };
}

function repairLegacyGroupMessageRoots() {
  for (const group of db.getGroupChats()) {
    const rootIds = db.getGroupRootMessageIds(group.id);
    if (rootIds.length <= 1) continue;

    for (const rootId of rootIds.slice(1)) {
      const previousMessageId = db.getLatestGroupMessageId(group.id, rootId);
      if (!previousMessageId) continue;

      db.updateGroupMessageParent(rootId, previousMessageId);
      console.log(`[Startup] Repaired extra group root ${group.id}:${rootId} -> parent ${previousMessageId}`);
    }
  }
}

// Auto-heal legacy group members that stored session IDs instead of OpenClaw agent IDs.
// This mainly affects the default "main" session whose session ID is random but agentId is "main".
for (const group of db.getGroupChats()) {
  for (const member of db.getGroupMembers(group.id)) {
    const linkedSession = db.getSession(member.agent_id);
    if (linkedSession && linkedSession.agentId && linkedSession.agentId !== member.agent_id) {
      db.updateGroupMemberAgentId(member.id, linkedSession.agentId);
      console.log(`[Startup] Repaired group member ${member.id}: ${member.agent_id} -> ${linkedSession.agentId}`);
    }
  }
}

repairLegacyGroupMessageRoots();

// Ensure main agent workspace is registered in openclaw.json at startup
const mainRegistered = agentProvisioner.ensureMainAgent();
if (mainRegistered) {
  console.log('[Startup] Main agent workspace registered in openclaw.json');
}

for (const group of db.getGroupChats()) {
  try {
    cleanupLegacyGroupRuntimeArtifacts(group.id);
  } catch (error) {
    console.error(`[Startup] Failed to cleanup legacy runtime artifacts for group ${group.id}:`, error);
  }
}

// LibreOffice detection
let hasLibreOffice = false;
const previewCacheDir = path.join(process.env.HOME || '.', '.clawui_preview_cache');
fs.mkdirSync(previewCacheDir, { recursive: true });

(async () => {
  try {
    await execPromise('which libreoffice');
    hasLibreOffice = true;
    console.log('[Preview] ✅ LibreOffice detected - high-fidelity preview enabled');
  } catch {
    hasLibreOffice = false;
    console.log('[Preview] ⚠️  LibreOffice not found - using client-side preview fallback');
  }
})();

// Host checking middleware for reverse proxies
app.use((req, res, next) => {
  const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
  const hostName = reqHost.split(':')[0]; // get hostname without port
  
  // Allow local connections and pure IPs
  if (!hostName || hostName === 'localhost' || hostName === '127.0.0.1' || net.isIP(hostName)) {
    return next();
  }

  const config = configManager.getConfig();
  const allowedHosts = config.allowedHosts || [];
  
  if (!allowedHosts.includes(hostName)) {
    return res.status(403).send(`Blocked request. This host ("${hostName}") is not allowed.`);
  }
  
  next();
});

// Helper to rewrite outgoing messages: extract /uploads/ images as attachments for the Vision API,
// and keep non-image file references as absolute paths in the message text.
function rewriteOutgoingMessage(
  message: string,
  agentId: string
): { text: string; attachments: { type: string; mimeType: string; content: string }[] } {
  const workspacePath = agentProvisioner.getWorkspacePath(agentId);
  const absoluteUploadsDir = path.join(workspacePath, 'uploads');
  return rewriteMessageWithWorkspaceUploads(message, absoluteUploadsDir, { extractImageAttachments: true });
}

const connections = new Map<string, OpenClawClient>();
const GROUP_RUNTIME_WORKSPACE_RESERVED_ROOT_ENTRIES = new Set([
  '.git',
  '.openclaw',
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
]);

function disconnectConnection(sessionId: string): void {
  const client = connections.get(sessionId);
  if (!client) return;
  connections.delete(sessionId);
  client.disconnect();
}

function createMigratedConflictPath(targetPath: string): string {
  const parsed = path.parse(targetPath);
  let attempt = 0;

  while (true) {
    attempt += 1;
    const candidate = path.join(parsed.dir, `${parsed.name}.migrated-${attempt}${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

function migrateGroupRuntimeWorkspaceContents(sourceDir: string, targetDir: string, rootLevel = true): void {
  if (!fs.existsSync(sourceDir) || sourceDir === targetDir) return;

  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (rootLevel && GROUP_RUNTIME_WORKSPACE_RESERVED_ROOT_ENTRIES.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(sourcePath, targetPath);
        continue;
      }

      if (!fs.statSync(targetPath).isDirectory()) {
        fs.renameSync(sourcePath, createMigratedConflictPath(targetPath));
        continue;
      }

      migrateGroupRuntimeWorkspaceContents(sourcePath, targetPath, false);
      if (fs.existsSync(sourcePath) && fs.readdirSync(sourcePath).length === 0) {
        fs.rmdirSync(sourcePath);
      }
      continue;
    }

    if (entry.isFile()) {
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(sourcePath, targetPath);
      } else {
        fs.renameSync(sourcePath, createMigratedConflictPath(targetPath));
      }
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      fs.renameSync(sourcePath, targetPath);
    } else {
      fs.rmSync(sourcePath, { recursive: true, force: true });
    }
  }
}

function readRuntimeSessionCwd(sessionFilePath: string): string | null {
  if (!fs.existsSync(sessionFilePath)) return null;

  try {
    const firstLine = fs.readFileSync(sessionFilePath, 'utf-8').split('\n')[0]?.trim();
    if (!firstLine) return null;
    const payload = JSON.parse(firstLine);
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}

function runtimeAgentSessionsNeedWorkspaceReset(agentId: string, workspacePath: string): boolean {
  const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
  if (!fs.existsSync(sessionsDir)) return false;

  const expectedWorkspace = path.resolve(workspacePath);
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

  if (fs.existsSync(sessionsJsonPath)) {
    try {
      const payload = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      for (const record of Object.values(payload || {})) {
        if (!record || typeof record !== 'object') continue;

        const workspaceDir = typeof (record as { workspaceDir?: unknown }).workspaceDir === 'string'
          ? path.resolve((record as { workspaceDir: string }).workspaceDir)
          : null;
        if (workspaceDir && workspaceDir !== expectedWorkspace) {
          return true;
        }

        const sessionFile = typeof (record as { sessionFile?: unknown }).sessionFile === 'string'
          ? (record as { sessionFile: string }).sessionFile
          : null;
        const cwd = sessionFile ? readRuntimeSessionCwd(sessionFile) : null;
        if (cwd && path.resolve(cwd) !== expectedWorkspace) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const cwd = readRuntimeSessionCwd(path.join(sessionsDir, entry.name));
    if (cwd && path.resolve(cwd) !== expectedWorkspace) {
      return true;
    }
  }

  return false;
}

function resetRuntimeAgentSessions(agentId: string): void {
  disconnectConnection(agentId);

  const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
}

// Rewrite absolute local file paths in AI responses to HTTP-accessible download URLs
function getSessionWorkspacePath(sessionId: string): string {
  const sessionInfo = sessionManager.getSession(sessionId);
  const agentId = sessionInfo?.agentId || 'main';
  return agentProvisioner.getWorkspacePath(agentId);
}

function rewriteOpenClawMediaPaths(text: string, workspacePath?: string): string {
  return rewriteVisibleFileLinks(text, { workspacePath });
}

function getGroupWorkspaceForDisplay(groupId: string): string {
  return getGroupWorkspacePath(groupId);
}

type UploadTarget = {
  contextType: 'session' | 'group';
  sessionKey: string;
  workspacePath: string;
  uploadsPath: string;
  agentId?: string;
  groupId?: string;
};

function createGroupIdValidationError(rawId: unknown): StructuredRequestError {
  const validation = validateGroupId(rawId);
  switch (validation.issue) {
    case 'required':
      return new StructuredRequestError(400, GROUP_ID_REQUIRED_ERROR_CODE);
    case 'whitespace':
      return new StructuredRequestError(400, GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE);
    default:
      return new StructuredRequestError(400, GROUP_ID_INVALID_ERROR_CODE, null, {
        groupId: validation.normalizedId || String(rawId || ''),
      });
  }
}

function resolveUploadTargetFromBody(body: Record<string, unknown> | undefined): UploadTarget {
  const contextType = typeof body?.contextType === 'string' ? body.contextType.trim() : '';
  const rawGroupId = typeof body?.groupId === 'string' ? body.groupId : '';

  if (contextType === 'group' || rawGroupId) {
    const validation = validateGroupId(rawGroupId);
    if (validation.issue) {
      throw createGroupIdValidationError(rawGroupId);
    }

    const groupId = validation.normalizedId;
    const group = db.getGroupChat(groupId);
    if (!group) {
      throw new StructuredRequestError(404, GROUP_NOT_FOUND_ERROR_CODE, null, { groupId });
    }

    const { workspacePath, uploadsPath } = ensureGroupWorkspace(groupId);
    return {
      contextType: 'group',
      sessionKey: groupId,
      workspacePath,
      uploadsPath,
      groupId,
    };
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const sessionInfo = sessionManager.getSession(sessionId);
  const agentId = sessionInfo?.agentId || 'main';
  const workspacePath = agentProvisioner.getWorkspacePath(agentId);

  return {
    contextType: 'session',
    sessionKey: sessionId,
    workspacePath,
    uploadsPath: path.join(workspacePath, 'uploads'),
    agentId,
  };
}

function removeStoredFilesFromDisk(files: StoredFileRow[]): void {
  for (const file of files) {
    if (!file.stored_path) continue;
    try {
      if (fs.existsSync(file.stored_path)) {
        fs.rmSync(file.stored_path, { force: true });
      }
    } catch (error) {
      console.error(`[Files] Failed to remove stored file ${file.stored_path}:`, error);
    }
  }
}

function clearStoredFilesBySessionKey(sessionKey: string): void {
  const files = db.getFilesBySession(sessionKey);
  removeStoredFilesFromDisk(files);
  db.deleteFilesBySession(sessionKey);
}

type GroupReconciliationAction =
  | { type: 'delete'; id: number; parent_id: number | null }
  | {
      type: 'edit';
      data: {
        groupId: string;
        id: number;
        parent_id: number | null;
        sender_type: 'agent';
        sender_id: string;
        sender_name: string;
        content: string;
        model_used?: string;
        messageCode?: string;
        messageParams?: StructuredMessageParams;
        rawDetail?: string;
        created_at: string;
      };
    };

const DEFAULT_PROCESS_START_TAG = '[执行工作_Start]';
const DEFAULT_PROCESS_END_TAG = '[执行工作_End]';

function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getGroupProcessTagPairs(groupId: string, agentId?: string): Array<{ startTag: string; endTag: string }> {
  const pairs: Array<{ startTag: string; endTag: string }> = [];
  const appendPair = (startTag?: string | null, endTag?: string | null) => {
    const normalizedStart = typeof startTag === 'string' ? startTag.trim() : '';
    const normalizedEnd = typeof endTag === 'string' ? endTag.trim() : '';
    if (!normalizedStart || !normalizedEnd) return;
    if (pairs.some((pair) => pair.startTag === normalizedStart && pair.endTag === normalizedEnd)) return;
    pairs.push({ startTag: normalizedStart, endTag: normalizedEnd });
  };

  const group = db.getGroupChat(groupId);
  appendPair(group?.process_start_tag, group?.process_end_tag);

  if (agentId) {
    const session = db.getSessionByAgentId(agentId) || db.getSession(agentId);
    appendPair(session?.process_start_tag, session?.process_end_tag);
  }

  appendPair(DEFAULT_PROCESS_START_TAG, DEFAULT_PROCESS_END_TAG);
  return pairs;
}

function stripProcessBlocks(content: string, pairs: Array<{ startTag: string; endTag: string }>): string {
  let cleaned = content;

  for (const pair of pairs) {
    const startPattern = escapeRegExpForPattern(pair.startTag);
    const endPattern = escapeRegExpForPattern(pair.endTag);
    const blockRegex = new RegExp(`${startPattern}[\\s\\S]*?(?:${endPattern}|$)`, 'g');
    cleaned = cleaned.replace(blockRegex, '\n\n');
    cleaned = cleaned.replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n');
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function hasUnclosedProcessBlock(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  return pairs.some((pair) => {
    const lastStartIndex = content.lastIndexOf(pair.startTag);
    if (lastStartIndex === -1) return false;
    const lastEndIndex = content.lastIndexOf(pair.endTag);
    return lastEndIndex < lastStartIndex;
  });
}

function isLikelyStaleInactiveGroupMessage(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (hasUnclosedProcessBlock(normalized, pairs)) return true;

  const containsProcessBlock = pairs.some((pair) => normalized.includes(pair.startTag));
  if (!containsProcessBlock) return false;

  return stripProcessBlocks(normalized, pairs).length === 0;
}

async function reconcileInactiveGroupLatestMessage(groupId: string): Promise<GroupReconciliationAction[]> {
  const runState = groupChatEngine.getGroupRunState(groupId);
  if (runState.active) {
    return [];
  }

  const recentMessages = db.getRecentGroupMessages(groupId, 100);
  const actions: GroupReconciliationAction[] = [];
  const staleMessageIds = recentMessages
    .filter((message) => (
      message.sender_type === 'agent'
      && typeof message.content === 'string'
      && message.content.trim() === ''
      && typeof message.id === 'number'
    ))
    .map((message) => message.id as number);

  for (const messageId of staleMessageIds) {
    const staleMessage = recentMessages.find((message) => message.id === messageId);
    db.deleteGroupMessage(messageId);
    actions.push({
      type: 'delete',
      id: messageId,
      parent_id: typeof staleMessage?.parent_id === 'number' ? staleMessage.parent_id : null,
    });
  }

  const latestAgentLikeMessage = [...recentMessages].reverse().find((message) => (
    message.sender_type === 'agent'
    && typeof message.id === 'number'
  ));

  if (!latestAgentLikeMessage?.id) {
    return actions;
  }

  const latestNonSystemAgentMessage = [...recentMessages].reverse().find((message) => (
    message.sender_type === 'agent'
    && typeof message.id === 'number'
    && !!message.sender_id
    && message.sender_id !== 'system'
  ));
  const latestStoredMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null;
  const latestStoredMessageIsAgent = !!latestStoredMessage
    && typeof latestStoredMessage.id === 'number'
    && latestStoredMessage.id === latestAgentLikeMessage.id
    && latestStoredMessage.sender_type === 'agent';
  const currentContent = typeof latestAgentLikeMessage.content === 'string' ? latestAgentLikeMessage.content : '';
  const currentStructured = getStructuredGroupMessage(currentContent);
  const isLatestSystemFailureMessage = latestAgentLikeMessage.sender_id === 'system'
    && currentStructured.messageCode === 'group.agentResponseFailed';
  const sourceAgentName = typeof currentStructured.messageParams?.agentName === 'string'
    ? currentStructured.messageParams.agentName.trim()
    : '';
  const groupMembers = db.getGroupMembers(groupId);
  const matchedMember = sourceAgentName
    ? groupMembers.find((member) => {
      const session = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
      const latestDisplayName = session?.name?.trim();
      return member.display_name === sourceAgentName || latestDisplayName === sourceAgentName;
    })
    : undefined;
  const sourceAgentId = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
    ? latestAgentLikeMessage.sender_id
    : (matchedMember?.agent_id || latestNonSystemAgentMessage?.sender_id || '');

  if (!sourceAgentId) {
    return actions;
  }

  const sourceAgentDisplayName = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
    ? (latestAgentLikeMessage.sender_name || sourceAgentId)
    : (matchedMember?.display_name || sourceAgentName || latestNonSystemAgentMessage?.sender_name || sourceAgentId);
  const processTagPairs = getGroupProcessTagPairs(groupId, sourceAgentId);
  const shouldAttemptHistoryReconciliation = latestStoredMessageIsAgent
    || actions.length > 0
    || isLikelyStaleInactiveGroupMessage(currentContent, processTagPairs);
  const shouldAttemptFailureRecovery = isLatestSystemFailureMessage;

  if (!shouldAttemptHistoryReconciliation && !shouldAttemptFailureRecovery) {
    return actions;
  }

  try {
    const runtimeContext = await prepareGroupRuntimeAgent(groupId, sourceAgentId);
    const client = await getConnection(runtimeContext.runtimeAgentId);
    const finalSessionKey = `agent:${runtimeContext.runtimeAgentId}:chat:${getGroupRuntimeSessionKey(groupId)}`;
    const history = await client.getChatHistory(finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
    const latestOutcomeRecord = extractLatestAssistantOutcomeRecord(history);
    const latestOutcome = latestOutcomeRecord.kind === 'text'
      ? { kind: 'text' as const, text: latestOutcomeRecord.text }
      : latestOutcomeRecord.kind === 'error'
        ? { kind: 'error' as const, error: latestOutcomeRecord.error }
        : { kind: 'none' as const };
    const latestMessageCreatedAtMs = Date.parse(latestAgentLikeMessage.created_at || '');
    const historyIsNewerThanCurrentMessage = latestOutcomeRecord.timestampMs !== null
      && Number.isFinite(latestMessageCreatedAtMs)
      && latestOutcomeRecord.timestampMs > latestMessageCreatedAtMs;

    if (latestOutcome.kind === 'none') {
      return actions;
    }

    if (latestOutcome.kind === 'error') {
      const { content, messageCode, messageParams, rawDetail } = createAgentResponseFailedMessage(
        sourceAgentDisplayName,
        latestOutcome.error,
      );

      if (
        latestAgentLikeMessage.content.trim() !== content.trim()
        || latestAgentLikeMessage.sender_id !== 'system'
        || latestAgentLikeMessage.sender_name !== '系统'
      ) {
        const modelUsed = latestAgentLikeMessage.model_used || agentProvisioner.readAgentModel(sourceAgentId) || undefined;
        db.updateGroupMessage(latestAgentLikeMessage.id, content, modelUsed, null);
        db.updateGroupMessageSender(latestAgentLikeMessage.id, 'system', '系统');
        actions.push({
          type: 'edit',
          data: {
            groupId,
            id: latestAgentLikeMessage.id,
            parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
            sender_type: 'agent',
            sender_id: 'system',
            sender_name: '系统',
            content,
            model_used: modelUsed,
            messageCode,
            messageParams,
            rawDetail,
            created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
          },
        });
      }

      return actions;
    }

    const allowShorterHistoryReplacement = isLatestSystemFailureMessage && historyIsNewerThanCurrentMessage;
    const preferredLatestText = selectPreferredTextSnapshot(currentContent, latestOutcome.text, {
      allowShorterReplacement: allowShorterHistoryReplacement,
    });
    const shouldReplaceWithHistoryText = preferredLatestText === latestOutcome.text && (
      shouldPreferSettledAssistantText(currentContent, latestOutcome.text)
      || (
        isLikelyStaleInactiveGroupMessage(currentContent, processTagPairs)
        && latestOutcome.text.trim() !== currentContent.trim()
      )
      || allowShorterHistoryReplacement
    );

    if (shouldReplaceWithHistoryText) {
      const modelUsed = latestAgentLikeMessage.model_used || agentProvisioner.readAgentModel(sourceAgentId) || undefined;
      db.updateGroupMessage(latestAgentLikeMessage.id, preferredLatestText, modelUsed, latestAgentLikeMessage.mentions || null);
      db.updateGroupMessageSender(latestAgentLikeMessage.id, sourceAgentId, sourceAgentDisplayName);
      actions.push({
        type: 'edit',
        data: {
          groupId,
          id: latestAgentLikeMessage.id,
          parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
          sender_type: 'agent',
          sender_id: sourceAgentId,
          sender_name: sourceAgentDisplayName,
          content: preferredLatestText,
          model_used: modelUsed,
          created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
        },
      });
    }
  } catch (error) {
    console.warn(`[GroupReconcile] Failed to reconcile latest inactive message for group ${groupId}:`, error);
  }

  return actions;
}

function broadcastGroupReconciliationActions(groupId: string, actions: GroupReconciliationAction[], targetClients?: Iterable<express.Response>) {
  if (actions.length === 0) return;

  const clients = targetClients ? Array.from(targetClients) : Array.from(groupSSEClients.get(groupId) || []);
  for (const action of actions) {
    const payload = action.type === 'delete'
      ? { type: 'delete', id: action.id, parent_id: action.parent_id }
      : { type: 'edit', ...withStructuredGroupMessage(action.data, { groupId }) };
    const data = JSON.stringify(payload);

    for (const client of clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {}
    }
  }
}

function removeAgentRuntimeState(agentId: string): void {
  const agentStatePath = getAgentStatePath(agentId);
  if (fs.existsSync(agentStatePath)) {
    fs.rmSync(agentStatePath, { recursive: true, force: true });
  }

  const memoryDbPath = getAgentMemoryDbPath(agentId);
  if (fs.existsSync(memoryDbPath)) {
    fs.rmSync(memoryDbPath, { force: true });
  }
}

function cleanupLegacyGroupRuntimeArtifacts(groupId: string): void {
  const groupWorkspacePath = getGroupWorkspacePath(groupId);
  const legacyRuntimeAgentIds = [
    getLegacyGroupRuntimeAgentId(groupId),
    getSharedGroupRuntimeAgentId(groupId),
  ];

  for (const legacyRuntimeAgentId of legacyRuntimeAgentIds) {
    removeAgentRuntimeState(legacyRuntimeAgentId);
    agentProvisioner.removeConfigEntry(legacyRuntimeAgentId);

    const legacyWorkspacePath = agentProvisioner.getWorkspacePath(legacyRuntimeAgentId);
    if (legacyWorkspacePath !== groupWorkspacePath && fs.existsSync(legacyWorkspacePath)) {
      fs.rmSync(legacyWorkspacePath, { recursive: true, force: true });
    }
  }
}

function collectGroupRuntimeAgentIds(groupId: string): string[] {
  const collected = new Set<string>([
    getLegacyGroupRuntimeAgentId(groupId),
    getSharedGroupRuntimeAgentId(groupId),
  ]);

  const runtimeAgentPrefix = getGroupRuntimeAgentPrefix(groupId);
  const openClawRoot = path.join(os.homedir(), '.openclaw');
  const agentStateRoot = path.join(openClawRoot, 'agents');
  if (fs.existsSync(agentStateRoot)) {
    for (const entry of fs.readdirSync(agentStateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(runtimeAgentPrefix)) {
        collected.add(entry.name);
      }
    }
  }

  const memoryRoot = path.join(openClawRoot, 'memory');
  if (fs.existsSync(memoryRoot)) {
    for (const entry of fs.readdirSync(memoryRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const agentId = entry.name.slice(0, -'.sqlite'.length);
      if (agentId.startsWith(runtimeAgentPrefix)) {
        collected.add(agentId);
      }
    }
  }

  const configPath = path.join(openClawRoot, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
      for (const entry of agentList) {
        if (typeof entry?.id === 'string' && entry.id.startsWith(runtimeAgentPrefix)) {
          collected.add(entry.id);
        }
      }
    } catch (error) {
      console.warn(`[GroupRuntime] Failed to read openclaw.json while collecting runtime agents for group ${groupId}:`, error);
    }
  }

  return Array.from(collected);
}

function cleanupGroupRuntimeAgent(groupId: string, options: { removeConfig?: boolean } = {}): void {
  for (const runtimeAgentId of collectGroupRuntimeAgentIds(groupId)) {
    removeAgentRuntimeState(runtimeAgentId);
    if (options.removeConfig) {
      agentProvisioner.removeConfigEntry(runtimeAgentId);
    }

    const runtimeWorkspacePath = agentProvisioner.getWorkspacePath(runtimeAgentId);
    if (fs.existsSync(runtimeWorkspacePath)) {
      fs.rmSync(runtimeWorkspacePath, { recursive: true, force: true });
    }
  }
}

async function prepareGroupRuntimeAgent(groupId: string, sourceAgentId: string): Promise<{
  runtimeAgentId: string;
  workspacePath: string;
  uploadsPath: string;
  outputPath: string;
}> {
  const { workspacePath, uploadsPath, outputPath } = ensureGroupWorkspace(groupId);
  const runtimeAgentId = getGroupRuntimeAgentId(groupId, sourceAgentId);
  const runtimeDefaultWorkspacePath = agentProvisioner.getWorkspacePath(runtimeAgentId);
  const sourceModelConfig = agentProvisioner.readAgentModelConfig(sourceAgentId);

  cleanupLegacyGroupRuntimeArtifacts(groupId);

  const hasLegacyRuntimeWorkspace = (
    runtimeDefaultWorkspacePath !== workspacePath
    && fs.existsSync(runtimeDefaultWorkspacePath)
  );

  if (hasLegacyRuntimeWorkspace) {
    migrateGroupRuntimeWorkspaceContents(runtimeDefaultWorkspacePath, workspacePath);
    fs.rmSync(runtimeDefaultWorkspacePath, { recursive: true, force: true });
  }

  if (hasLegacyRuntimeWorkspace || runtimeAgentSessionsNeedWorkspaceReset(runtimeAgentId, workspacePath)) {
    resetRuntimeAgentSessions(runtimeAgentId);
  }

  await agentProvisioner.provision({
    agentId: runtimeAgentId,
    workspaceDir: workspacePath,
    soulContent: agentProvisioner.readSoul(sourceAgentId) || undefined,
    userContent: agentProvisioner.readAgentFile(sourceAgentId, 'USER.md', ''),
    agentsContent: agentProvisioner.readAgentFile(sourceAgentId, 'AGENTS.md', ''),
    toolsContent: agentProvisioner.readAgentFile(sourceAgentId, 'TOOLS.md', ''),
    heartbeatContent: agentProvisioner.readAgentFile(sourceAgentId, 'HEARTBEAT.md', ''),
    identityContent: agentProvisioner.readAgentFile(sourceAgentId, 'IDENTITY.md', ''),
    model: sourceModelConfig.modelOverride || undefined,
    fallbackMode: sourceModelConfig.fallbackMode,
    fallbacks: sourceModelConfig.fallbacks,
  });

  if (runtimeDefaultWorkspacePath !== workspacePath && fs.existsSync(runtimeDefaultWorkspacePath)) {
    fs.rmSync(runtimeDefaultWorkspacePath, { recursive: true, force: true });
  }

  return {
    runtimeAgentId,
    workspacePath,
    uploadsPath,
    outputPath,
  };
}

// Helper to get or create connection
async function getConnection(sessionId: string): Promise<OpenClawClient> {
  if (connections.has(sessionId)) {
    return connections.get(sessionId)!;
  }

  const config = configManager.getConfig();
  const client = new OpenClawClient({
    gatewayUrl: config.gatewayUrl,
    token: config.token,
    password: config.password,
  });
  client.on('error', (err) => {
    console.error(`[OpenClawClient Error for session ${sessionId}]`, err.message);
  });

  await client.connect();
  connections.set(sessionId, client);

  client.on('disconnected', () => {
    connections.delete(sessionId);
  });

  return client;
}

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: connections.size,
  });
});

// API Routes
app.get('/api/version', (_req, res) => {
  (async () => {
    try {
      res.json({
        ...getCurrentAppVersionInfo(),
        openclawVersion: await readOpenClawVersion(),
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredApiError(
        VERSION_INFO_UNAVAILABLE_ERROR_CODE,
        error instanceof Error ? error.message : String(error),
      ));
    }
  })().catch((error: any) => {
    res.status(500).json(buildStructuredApiError(
      VERSION_INFO_UNAVAILABLE_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  });
});

app.get('/api/version/latest', async (_req, res) => {
  try {
    const latestInfo = await getLatestVersionInfo();
    rememberLatestVersionInfo(latestInfo);
    res.json(latestInfo);
  } catch (error: any) {
    console.error('[VersionCheck] Failed to fetch latest release:', error instanceof Error ? error.message : String(error));
    res.status(502).json(buildStructuredApiError(
      VERSION_LOOKUP_FAILED_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  }
});

app.get('/api/openclaw/version/latest', async (_req, res) => {
  try {
    const latestInfo = await getOpenClawLatestVersionInfo();
    res.json(latestInfo);
  } catch (error: any) {
    console.error('[OpenClawVersionCheck] Failed to fetch latest version:', error instanceof Error ? error.message : String(error));
    res.status(502).json(buildStructuredApiError(
      OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  }
});

app.get('/api/openclaw/update/status', requireAdminAuth, (_req, res) => {
  res.json({
    success: true,
    update: buildOpenClawUpdateStatusResponse(),
  });
});

app.post('/api/openclaw/update/start', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await startOpenClawUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_START_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/openclaw/update/cancel', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await cancelOpenClawUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/openclaw/update/reset', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await resetOpenClawUpdateTaskState();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE, detail));
  });
});

app.get('/api/update/status', requireAdminAuth, (_req, res) => {
  res.json({
    success: true,
    update: buildUpdateStatusResponse(),
  });
});

app.post('/api/update/start', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await startUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_START_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/cancel', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await cancelUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/reset', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await resetUpdateTaskState();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_RESET_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/restart-service', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await restartClawUiService();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_RESTART_FAILED_ERROR_CODE, detail));
  });
});

app.get('/api/config', (_req, res) => {
  const config = configManager.getConfig();
  res.json({
    gatewayUrl: config.gatewayUrl,
    token: config.token || '',
    defaultAgent: config.defaultAgent,
    language: config.language || 'zh-CN',
    hasToken: !!config.token,
    hasPassword: !!config.password,
    aiName: config.aiName || 'OpenClaw',
    loginEnabled: config.loginEnabled || false,
    loginPassword: config.loginPassword || '123456',
    allowedHosts: config.allowedHosts || [],
    historyPageRounds: config.historyPageRounds || 30,
  });
});

app.post('/api/config', (req, res) => {
  configManager.setConfig(req.body);
  res.json({ success: true });
});

app.get('/api/sidebar/favorites', (_req, res) => {
  const config = configManager.getConfig();
  res.json({
    success: true,
    favorites: config.sidebarFavorites || {
      agents: [],
      groups: [],
      order: [],
    },
  });
});

app.post('/api/sidebar/favorites', (req, res) => {
  configManager.setConfig({
    sidebarFavorites: req.body?.favorites ?? req.body,
  });
  const config = configManager.getConfig();
  res.json({
    success: true,
    favorites: config.sidebarFavorites || {
      agents: [],
      groups: [],
      order: [],
    },
  });
});

import crypto from 'crypto';

function generateAuthToken(password: string): string {
  return crypto.createHash('sha256').update(password + '_clawui_salt').digest('hex');
}

function readRequestAuthToken(req: express.Request): string {
  const forwarded = req.header('x-clawui-auth-token');
  if (forwarded) return normalizeCliText(forwarded);
  const authorization = normalizeCliText(req.header('authorization'));
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return '';
}

function requireAdminAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const config = configManager.getConfig();
  if (!config.loginEnabled) {
    return next();
  }

  const expectedToken = generateAuthToken(config.loginPassword || '123456');
  const providedToken = readRequestAuthToken(req);
  if (providedToken && providedToken === expectedToken) {
    return next();
  }

  return next(new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.'));
}

// Auth endpoints
app.get('/api/auth/check', (req, res) => {
  const config = configManager.getConfig();
  const providedToken = req.query.token as string | undefined;
  
  if (!config.loginEnabled) {
     return res.json({ loginRequired: false });
  }

  const correctPassword = config.loginPassword || '123456';
  const expectedToken = generateAuthToken(correctPassword);

  if (providedToken && providedToken === expectedToken) {
     return res.json({ loginRequired: false });
  }

  res.json({ loginRequired: true });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const config = configManager.getConfig();
  
  if (!config.loginEnabled) {
    return res.json({ success: true, token: 'disabled' });
  }
  
  const correctPassword = config.loginPassword || '123456';
  if (password === correctPassword) {
    res.json({ success: true, token: generateAuthToken(correctPassword) });
  } else {
    res.status(401).json({
      success: false,
      errorCode: 'auth.invalidPassword',
      errorParams: null,
      errorDetail: null,
    });
  }
});

app.get('/api/gateway/status', async (_req, res) => {
  const config = configManager.getConfig();
  if (!config.gatewayUrl) {
    return res.json({ connected: false, message: 'Gateway URL not configured' });
  }

  try {
    const result = await probeGatewayConnectionStatus({
      gatewayUrl: config.gatewayUrl,
      token: config.token,
      password: config.password,
    });
    res.json({
      connected: result.connected,
      message: result.message,
      source: result.source,
    });
  } catch (error: any) {
    res.json({ connected: false, message: error?.message || 'Connection failed' });
  }
});

app.post('/api/config/test', async (req, res) => {
  const { gatewayUrl, token, password } = req.body;

  if (!gatewayUrl) {
    return res.status(400).json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, 'Gateway URL is required'));
  }

  try {
    const result = await probeGatewayConnectionStatus({ gatewayUrl, token, password }, { requireAuth: true });
    if (result.connected) {
      return res.json({ success: true, message: 'Connection successful', source: result.source });
    }

    res.json(buildStructuredApiError(
      GATEWAY_TEST_FAILED_ERROR_CODE,
      result.message || 'Connection failed',
    ));
  } catch (error: any) {
    console.error('[API] /api/config/test - Connection failed:', error);
    res.json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, error?.message || 'Connection failed'));
  }
});

app.get('/api/config/detect-all', async (_req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    let gatewayUrl = '';
    let token = '';
    let password = '';
    const openclawVersion = await readOpenClawVersion();

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.gateway) {
        gatewayUrl = `ws://127.0.0.1:${config.gateway.port || 18789}`;
        token = config.gateway.auth?.token || '';
        password = config.gateway.auth?.password || '';
      }
    }

    if (!gatewayUrl) {
      return res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, 'Could not detect gateway config'));
    }

    res.json({
      success: true,
      data: {
        gatewayUrl,
        token,
        password,
        openclawVersion,
      }
    });
  } catch (error: any) {
    res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, error?.message || 'Error detecting config'));
  }
});

// --- Max Permissions Toggle ---
const MAX_PERMISSIONS_TOOLS = {
  web: {
    fetch: { enabled: true }
  },
  exec: {
    security: 'full',
    ask: 'off'
  },
  elevated: {
    enabled: true,
    allowFrom: { webchat: ['*'], '*': ['*'] }
  }
};

app.get('/api/config/browser-health/status', (_req, res) => {
  res.json({
    success: true,
    task: getBrowserTaskSnapshot(),
  });
});

app.get('/api/config/browser-health', async (_req, res) => {
  let taskStarted = false;
  try {
    ensureBrowserTaskIdle();
    updateBrowserTaskSnapshot({
      status: 'checking',
      phase: 'read-config',
      rawDetail: null,
    });
    taskStarted = true;
    const health = await runBrowserHealthCheck((phase, rawDetail) => {
      updateBrowserTaskSnapshot({
        status: 'checking',
        phase,
        rawDetail: normalizeCliText(rawDetail) || null,
      });
    });
    res.json({ success: true, health });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    res.json(buildStructuredApiError(
      BROWSER_HEALTH_FAILED_ERROR_CODE,
      readCliErrorDetail(error) || error?.message || 'Browser health check failed'
    ));
  } finally {
    if (taskStarted) {
      resetBrowserTaskSnapshot();
    }
  }
});

app.get('/api/config/browser-headed-mode', (_req, res) => {
  try {
    res.json({
      success: true,
      config: readBrowserHeadedModeConfig(),
    });
  } catch (error: any) {
    res.status(500).json(buildStructuredApiError(
      BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE,
      error?.message || 'Failed to load browser headed mode config'
    ));
  }
});

app.post('/api/config/browser-headed-mode', (req, res) => {
  const { headedModeEnabled } = req.body ?? {};
  if (typeof headedModeEnabled !== 'boolean') {
    return res.status(400).json(buildStructuredApiError(
      BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
      'headedModeEnabled must be a boolean'
    ));
  }

  try {
    const config = setBrowserHeadedModeEnabled(headedModeEnabled);
    res.json({
      success: true,
      config,
      restartQueued: true,
    });

    void (async () => {
      await stopOpenClawBrowserBestEffort();
      await scheduleGatewayRestart();
    })().catch((error: any) => {
      console.error('[BrowserHeadedMode] Failed to apply browser mode update:', error?.message || error);
    });
  } catch (error: any) {
    res.status(500).json(buildStructuredApiError(
      BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
      error?.message || 'Failed to update browser headed mode config'
    ));
  }
});

app.post('/api/config/browser-health/self-heal', async (_req, res) => {
  let taskStarted = false;
  try {
    ensureBrowserTaskIdle();
    updateBrowserTaskSnapshot({
      status: 'repairing',
      phase: 'inspect-current',
      rawDetail: null,
    });
    taskStarted = true;

    const reportRepairProgress = (phase: string, rawDetail?: string | null) => {
      updateBrowserTaskSnapshot({
        status: 'repairing',
        phase,
        rawDetail: normalizeCliText(rawDetail) || null,
      });
    };

    const before = await runBrowserHealthCheck(reportRepairProgress);

    reportRepairProgress('enable-permissions');
    setMaxPermissionsEnabled(true);
    reportRepairProgress('restart-gateway');
    await restartGatewayService();
    reportRepairProgress('stop-browser');
    await stopOpenClawBrowserBestEffort();
    const after = await waitForBrowserHealth(BROWSER_SELF_HEAL_POLL_TIMEOUT_MS, reportRepairProgress);

    res.json({
      success: true,
      before,
      after,
      gatewayRestarted: true,
    });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    res.json(buildStructuredApiError(
      BROWSER_SELF_HEAL_FAILED_ERROR_CODE,
      readCliErrorDetail(error) || error?.message || 'Browser self-heal failed'
    ));
  } finally {
    if (taskStarted) {
      resetBrowserTaskSnapshot();
    }
  }
});

app.get('/api/config/max-permissions', (_req, res) => {
  try {
    res.json({ enabled: readMaxPermissionsEnabled() === true });
  } catch (error: any) {
    res.json({ enabled: false });
  }
});

app.post('/api/config/max-permissions', (req, res) => {
  (async () => {
    const { enabled } = req.body;
    setMaxPermissionsEnabled(Boolean(enabled));
    res.json({ success: true, enabled: Boolean(enabled) });

    void scheduleGatewayRestart().catch((error: any) => {
      console.error('[MaxPermissions] Failed to restart gateway after config update:', error?.message || error);
    });
  })().catch((error: any) => {
    res.status(500).json({ success: false, message: error.message });
  });
});

app.post('/api/config/restart', async (_req, res) => {
  try {
    // Disconnect all active clients first
    for (const [sessionId, client] of connections.entries()) {
      try {
        client.disconnect();
      } catch (err) {
        console.error(`Error disconnecting client ${sessionId}:`, err);
      }
    }
    connections.clear();

    // Execute the actual restart command on the system
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    await execFilePromise(executablePath, ['gateway', 'restart']);

    res.json({ success: true, message: 'Gateway connections reset and service restarted' });
  } catch (error: any) {
    console.error('Failed to restart gateway:', error);
    res.status(500).json(buildStructuredApiError(GATEWAY_RESTART_FAILED_ERROR_CODE, error?.message));
  }
});

app.get('/api/models', (_req, res) => {
  const models = agentProvisioner.readAvailableModels();
  res.json({ success: true, models });
});

app.get('/api/models/fallbacks', (_req, res) => {
  try {
    res.json({
      success: true,
      config: agentProvisioner.readGlobalModelConfig(),
    });
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.put('/api/models/fallbacks', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.fallbacks)) {
      return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'fallbacks must be an array'));
    }

    const success = await agentProvisioner.updateGlobalFallbacks(normalizeFallbackList(req.body.fallbacks));
    res.json({
      success: true,
      changed: success,
      config: agentProvisioner.readGlobalModelConfig(),
    });
  } catch (err: any) {
    const detail = typeof err?.message === 'string' ? err.message : '';
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail || 'Failed to update fallback models'));
  }
});

app.post('/api/models/test', async (req, res) => {
  try {
    const { endpoint, modelName } = req.body;
    if (!endpoint || !modelName) {
      return res.status(400).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'endpoint and modelName required'));
    }

    const endpoints = agentProvisioner.getEndpoints();
    const config = endpoints.find((e: any) => e.id === endpoint);
    if (!config) {
      return res.status(404).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'Endpoint not found'));
    }

    let baseUrl = config.baseUrl;
    const apiKey = config.apiKey || '';
    const apiType = config.api.toLowerCase();

    let testUrl = '';
    let headers: any = {
      'Content-Type': 'application/json'
    };
    let body: any = {};

    if (apiType.includes('anthropic')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/messages`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 5
      };
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/models/${modelName}:generateContent?key=${apiKey}`;
      body = {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: { maxOutputTokens: 5 }
      };
    } else if (apiType.includes('ollama')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/api/chat`; 
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      };
    } else {
      // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
      testUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 5,
        stream: false
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const startTime = Date.now();
    try {
      const resp = await fetch(testUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latency = Date.now() - startTime;
      if (resp.ok) {
        return res.json({ success: true, message: '模型有效连通', latency });
      } else {
        const errorText = await (await resp.blob()).text();
        let errMsg = `HTTP ${resp.status} ${resp.statusText}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.error?.message) errMsg += ` - ${parsed.error.message}`;
          else if (parsed.error) errMsg += ` - ${JSON.stringify(parsed.error)}`;
          else if (parsed.message) errMsg += ` - ${parsed.message}`;
        } catch {
          if (errorText.length > 0) errMsg += ` - ${errorText.substring(0, 100)}`;
        }
        return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, errMsg));
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, e?.message || 'Network connection failed'));
    }
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message));
  }
});

app.get('/api/models/discover', async (req, res) => {
  try {
    const endpoint = req.query.endpoint as string;
    if (!endpoint) {
      return res.status(400).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'endpoint required'));
    }

    const endpoints = agentProvisioner.getEndpoints();
    const config = endpoints.find((e: any) => e.id === endpoint);
    if (!config) {
      return res.status(404).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'Endpoint not found'));
    }

    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const apiKey = config.apiKey || '';
    const apiType = config.api.toLowerCase();

    let discoverUrl = '';
    const headers: any = {
      'Content-Type': 'application/json'
    };

    if (apiType.includes('anthropic')) {
      discoverUrl = `${baseUrl}/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      discoverUrl = `${baseUrl}/models?key=${apiKey}`;
    } else if (apiType.includes('ollama')) {
      discoverUrl = `${baseUrl}/api/tags`;
    } else {
      // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
      discoverUrl = `${baseUrl}/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(discoverUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorText = await resp.text();
      return res.status(resp.status).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, `Failed to discover models: HTTP ${resp.status} - ${errorText.substring(0, 100)}`));
    }

    const data: any = await resp.json();
    let models: string[] = [];

    if (apiType.includes('ollama')) {
      if (data.models && Array.isArray(data.models)) {
        models = data.models.map((m: any) => m.name);
      }
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      if (data.models && Array.isArray(data.models)) {
        models = data.models.map((m: any) => m.name.replace('models/', ''));
      }
    } else {
      // OpenAI / Anthropic format
      if (data.data && Array.isArray(data.data)) {
        models = data.data.map((m: any) => m.id);
      } else if (Array.isArray(data)) {
         models = data.map((m: any) => m.id || m.name);
      }
    }

    return res.json({ success: true, models: models.filter(Boolean) });
  } catch (err: any) {
    return res.status(500).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, err?.message || 'Network error during discovery'));
  }
});

app.post('/api/models/manage', async (req, res) => {
  try {
    const { endpoint, modelName, alias, input } = req.body;
    if (!endpoint || !modelName) {
      return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'endpoint and modelName required'));
    }
    const success = await agentProvisioner.addModelConfig(endpoint, modelName, alias, Array.isArray(input) ? input : undefined);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'Model may already exist or config invalid'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/models/manage', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'id required'));
    
    const success = await agentProvisioner.deleteModelConfig(id);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(404).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'Model not found'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, err?.message));
  }
});

app.put('/api/models/manage/default', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const success = await agentProvisioner.setDefaultModel(id);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Model not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/models/manage', async (req, res) => {
  try {
    const { id, alias, input } = req.body;
    if (!id) return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'id required'));

    const success = await agentProvisioner.updateModelConfig(id, alias, Array.isArray(input) ? input : undefined);
    if (success) {
      return res.json({ success: true });
    }
    return res.status(404).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'Model not found'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/endpoints/manage', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'endpoint required'));

    const count = await agentProvisioner.deleteEndpointConfig(endpoint);
    if (count > 0) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true, deleted: count });
    }
    return res.status(404).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'Endpoint not found or no models under it'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, err?.message));
  }
});
app.get('/api/endpoints', (_req, res) => {
  try {
    const endpoints = agentProvisioner.getEndpoints();
    res.json({ success: true, endpoints });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/endpoints/test', async (req, res) => {
  try {
    const { baseUrl, apiKey, api } = req.body;
    if (!baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, 'baseUrl and api are required'));
    }

    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiType = api.toLowerCase();

    let discoverUrl = '';
    const headers: any = {
      'Content-Type': 'application/json'
    };

    if (apiType.includes('anthropic')) {
      discoverUrl = `${cleanBaseUrl}/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      discoverUrl = `${cleanBaseUrl}/models?key=${apiKey}`;
    } else if (apiType.includes('ollama')) {
      discoverUrl = `${cleanBaseUrl}/api/tags`;
    } else {
      discoverUrl = `${cleanBaseUrl}/models`;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(discoverUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resp.ok) {
        return res.json({ success: true });
    } else {
        const errText = await resp.text();
        return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, `Status ${resp.status}: ${errText.substring(0, 100)}`));
    }
  } catch (err: any) {
    return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, err?.message || 'Connection failed'));
  }
});

app.post('/api/endpoints', async (req, res) => {
  try {
    const { id, baseUrl, apiKey, api } = req.body;
    if (!id || !baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'id, baseUrl, and api are required'));
    }

    const success = await agentProvisioner.saveEndpoint(id, { baseUrl, apiKey, api });
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'Failed to save endpoint'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.get('/api/characters', (_req, res) => {
  const characters = db.getCharacters().map(char => {
    const diskSoul = agentProvisioner.readSoul(char.agentId);
    if (diskSoul !== null) {
      char.systemPrompt = diskSoul;
    }
    // Always read the actual model from openclaw.json (source of truth)
    const actualModel = agentProvisioner.readAgentModel(char.agentId);
    if (actualModel) {
      char.model = actualModel;
    }
    return char;
  });
  res.json({ success: true, characters });
});

app.post('/api/characters', async (req, res) => {
  try {
    const char = req.body;
    if (!char.id) char.id = 'char_' + Date.now();

    // Validate agentId
    if (!char.agentId) {
      return res.status(400).json({ success: false, error: '智能体 ID 不能为空' });
    }
    if (/\s/.test(char.agentId)) {
      return res.status(400).json({ success: false, error: '智能体 ID 不允许包含空格' });
    }
    
    // Check for duplicate agentId (excluding the current character being edited)
    const existingChars = db.getCharacters();
    const isDuplicate = existingChars.some(c => c.agentId === char.agentId && c.id !== char.id);
    if (isDuplicate) {
      return res.status(400).json({ success: false, error: `智能体 ID "${char.agentId}" 已存在，请使用其他 ID` });
    }

    // Provision full isolated environment in OpenClaw (workspace, SOUL.md, USER.md, etc.)
    const configChanged = await agentProvisioner.provision({
      agentId: char.agentId,
      soulContent: char.systemPrompt,
      model: char.model,
    });
    
    // Also update SOUL.md if this is an existing character being re-saved
    if (!configChanged) {
      await agentProvisioner.updateSoul(char.agentId, char.systemPrompt);
      // Update model in config if changed
      const modelChanged = await agentProvisioner.updateModel(char.agentId, char.model);
      if (modelChanged) {
        // Gateway auto-reloads config
      }
    }
    
    db.saveCharacter(char);

    if (configChanged) {
        console.log('OpenClaw config changed for new agent, auto-reloading...');
    }

    res.json({ success: true, character: char });
  } catch (err: any) {
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/characters/:id', async (req, res) => {
  try {
    const character = db.getCharacters().find(c => c.id === req.params.id);
    if (!character) {
      return res.status(404).json({ success: false, error: 'Character not found' });
    }

    db.deleteCharacter(req.params.id);

    // Deprovision agent: remove from OpenClaw config + delete workspace & state dirs
    if (character.agentId && character.agentId !== 'main') {
      const configChanged = await agentProvisioner.deprovision(character.agentId);
      if (configChanged) {
        console.log(`Agent "${character.agentId}" fully removed, gateway auto-reloading...`);
      }
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting character:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// USER.md read/write API for per-character user profile
app.get('/api/characters/:agentId/user-md', (req, res) => {
  const content = agentProvisioner.readUserMd(req.params.agentId);
  res.json({ success: true, content });
});

app.put('/api/characters/:agentId/user-md', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing content' });
  }
  agentProvisioner.writeUserMd(req.params.agentId, content);
  res.json({ success: true });
});

app.get('/api/sessions', (_req, res) => {
  const sessions = sessionManager.getAllSessions();
  const sessionsWithModel = sessions.map(session => {
    return {
      ...session,
      model: agentProvisioner.readAgentModel(session.agentId) || ''
    };
  });
  res.json(sessionsWithModel);
});

app.post('/api/sessions', async (req, res) => {
  const { id, name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
  const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
  const fallbacks = normalizeFallbackList(req.body?.fallbacks);
  const prompt = soulContent;

  const rawId = typeof id === 'string' ? id : '';
  const normalizedId = rawId.trim();

  if (!normalizedId) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_REQUIRED_ERROR_CODE));
  }

  if (/\s/.test(rawId)) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE));
  }

  if (sessionManager.getSession(normalizedId)) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_ALREADY_EXISTS_ERROR_CODE, null, { agentId: normalizedId }));
  }

  try {
    // Provide basic default for first session if it doesn't exist
    const newSession = sessionManager.createSession({ id: normalizedId, name, prompt, process_start_tag, process_end_tag });
    const agentId = newSession.id;

    // Provision agent workspace
    await agentProvisioner.provision({ 
      agentId, 
      soulContent: prompt,
      userContent,
      agentsContent,
      toolsContent,
      heartbeatContent,
      identityContent,
      model,
      fallbackMode,
      fallbacks,
    });
    
    // Update session record with the auto-generated agentId
    sessionManager.updateSession(newSession.id, { agentId });
    const finalSession = sessionManager.getSession(newSession.id);

    res.json({ success: true, session: finalSession });
  } catch (err: any) {
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.put('/api/sessions/:id', async (req, res) => {
  const { name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
  const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
  const fallbacks = normalizeFallbackList(req.body?.fallbacks);
  const prompt = soulContent;
  const session = sessionManager.getSession(req.params.id);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const updated = sessionManager.updateSession(req.params.id, { name, prompt, process_start_tag, process_end_tag });
    
    if (session.agentId) {
      await agentProvisioner.updateSoul(session.agentId, prompt || '');
      if (userContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'USER.md', userContent);
      if (agentsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'AGENTS.md', agentsContent);
      if (toolsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'TOOLS.md', toolsContent);
      if (heartbeatContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'HEARTBEAT.md', heartbeatContent);
      if (identityContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'IDENTITY.md', identityContent);
      
      // Model update might require gateway restart
      const modelChanged = await agentProvisioner.updateModel(session.agentId, model, { mode: fallbackMode, fallbacks });
      if (modelChanged) {
        // Gateway auto-reloads config
      }
    }

    res.json({ success: true, session: updated });
  } catch (err: any) {
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  if (session.id === 'main' || session.agentId === 'main') {
    return res.status(400).json({ success: false, error: 'Cannot delete the main agent session' });
  }

  const agentId = session.agentId;
  const success = sessionManager.deleteSession(req.params.id);
  
  if (success) {
    if (agentId && agentId !== 'main') {
      const configChanged = await agentProvisioner.deprovision(agentId);
      if (configChanged) {
        // Gateway auto-reloads config
      }
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Reset session (clear history, files, context but keep session entity)
app.post('/api/sessions/:id/reset', async (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const agentId = session.agentId;

    // Clear database records
    db.deleteMessagesBySession(req.params.id);
    db.deleteFilesBySession(req.params.id);

    // Clear agent workspace uploads directory
    if (agentId) {
      const workspacePath = agentProvisioner.getWorkspacePath(agentId);
      const uploadsPath = path.join(workspacePath, 'uploads');
      if (fs.existsSync(uploadsPath)) {
        fs.rmSync(uploadsPath, { recursive: true, force: true });
        fs.mkdirSync(uploadsPath, { recursive: true });
      }

      // Clear agent state directory
      const agentStatePath = path.join(process.env.HOME || '.', '.openclaw', 'agents', agentId);
      if (fs.existsSync(agentStatePath)) {
        fs.rmSync(agentStatePath, { recursive: true, force: true });
      }

      // Clear agent memory database
      const memoryDbPath = path.join(process.env.HOME || '.', '.openclaw', 'memory', `${agentId}.sqlite`);
      if (fs.existsSync(memoryDbPath)) {
        fs.rmSync(memoryDbPath, { force: true });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to reset session:', err);
    res.status(500).json({ success: false, error: 'Failed to reset session' });
  }
});

// Endpoint to fetch all configuring MD files for a given session's agent
app.get('/api/sessions/:id/configs', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  const agentId = session.agentId;
  const modelConfig = agentProvisioner.readAgentModelConfig(agentId);
  res.json({
    success: true,
    configs: {
      soulContent: agentProvisioner.readSoul(agentId) || '',
      userContent: agentProvisioner.readAgentFile(agentId, 'USER.md', ''),
      agentsContent: agentProvisioner.readAgentFile(agentId, 'AGENTS.md', ''),
      toolsContent: agentProvisioner.readAgentFile(agentId, 'TOOLS.md', ''),
      heartbeatContent: agentProvisioner.readAgentFile(agentId, 'HEARTBEAT.md', ''),
      identityContent: agentProvisioner.readAgentFile(agentId, 'IDENTITY.md', ''),
      model: modelConfig.model,
      modelOverride: modelConfig.modelOverride,
      resolvedModel: modelConfig.resolvedModel,
      fallbackMode: modelConfig.fallbackMode,
      fallbacks: modelConfig.fallbacks,
    }
  });
});

app.post('/api/sessions/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'Invalid ids format' });
  }
  sessionManager.reorderSessions(ids);
  res.json({ success: true });
});

app.get('/api/history/:sessionId', (req, res) => {
  const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
  const result = db.getMessagesPage(req.params.sessionId, { beforeId, limit });
  res.json(buildHistoryPageResponse(
    result.rows.map((row) => withStructuredChatMessage(row, { sessionId: req.params.sessionId })),
    result.pageInfo,
  ));
});

app.get('/api/history/:sessionId/search', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(buildHistorySearchResponse(db.searchMessages(req.params.sessionId, query)));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ success: false, error: 'Content is required' });
  try {
    db.updateMessageContent(Number(id), content);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.deleteMessage(Number(id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

interface ActiveRun {
  sessionId: string;
  runId: string;
  agentId: string;
  agentName: string;
  modelUsed: string;
  messageId: number;
  workspacePath: string;
  finalSessionKey: string;
  historySnapshot: ChatHistorySnapshot;
  text: string;           // Accumulated text so far
  clients: express.Response[]; // Active SSE clients listening to this run
  idleTimeout?: NodeJS.Timeout;
  completionProbeTimer?: NodeJS.Timeout;
  completionProbeInFlight?: boolean;
  completionProbePending?: boolean;
  firstCompletionWaitResolvedAt?: number;
  visibleFinalText?: string;
  finalEventText?: string;
  finalEventGeneration: number;
  settledCalibrationGeneration: number;
  clientRef?: OpenClawClient;
}

function resolveChatFinalTextSnapshot(text: string, message: any): string {
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

class ActiveRunManager {
  private runs = new Map<string, ActiveRun>();
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  getRun(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }

  async abortRun(sessionId: string): Promise<{ aborted: boolean }> {
    const run = this.runs.get(sessionId);
    if (!run || !run.clientRef) {
      return { aborted: false };
    }

    const result = await run.clientRef.abortChat({
      sessionKey: run.finalSessionKey,
      runId: run.runId,
    });

    const rewritten = rewriteOpenClawMediaPaths(run.text || '', run.workspacePath);
    this.db.updateMessage(run.messageId, rewritten, run.modelUsed);

    run.clients.forEach((res) => {
      res.write(`data: ${JSON.stringify({ type: 'final', text: rewritten })}\n\n`);
      res.end();
    });

    this.cleanupRun(sessionId);
    return { aborted: result.aborted };
  }

  private emitVisibleFinal(run: ActiveRun, finalText: string, options?: { end?: boolean }) {
    const protectedFinalText = selectPreferredTextSnapshot(run.text, finalText);
    if (protectedFinalText) {
      run.text = protectedFinalText;
    }
    const rewritten = rewriteOpenClawMediaPaths(protectedFinalText || run.text, run.workspacePath);
    const nextVisibleFinalText = selectPreferredTextSnapshot(run.visibleFinalText, rewritten);
    if (!nextVisibleFinalText.trim()) {
      if (options?.end) {
        run.clients.forEach((res) => {
          res.end();
        });
      }
      return '';
    }

    const shouldSendFinalEvent = run.visibleFinalText !== nextVisibleFinalText;
    if (shouldSendFinalEvent) {
      run.visibleFinalText = nextVisibleFinalText;
      run.clients.forEach((res) => {
        res.write(`data: ${JSON.stringify({ type: 'final', text: nextVisibleFinalText })}\n\n`);
        if (options?.end) {
          res.end();
        }
      });
      return nextVisibleFinalText;
    }

    if (options?.end) {
      run.clients.forEach((res) => {
        res.end();
      });
    }

    return nextVisibleFinalText;
  }

  startRun(
    sessionId: string,
    runId: string,
    agentId: string,
    agentName: string,
    modelUsed: string,
    messageId: number,
    workspacePath: string,
    clientRef: OpenClawClient,
    finalSessionKey: string,
    historySnapshot: ChatHistorySnapshot
  ): ActiveRun {
    const run: ActiveRun = {
      sessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      messageId,
      workspacePath,
      finalSessionKey,
      historySnapshot,
      text: '',
      clients: [],
      completionProbePending: false,
      firstCompletionWaitResolvedAt: undefined,
      finalEventGeneration: 0,
      settledCalibrationGeneration: 0,
      clientRef
    };
    this.runs.set(sessionId, run);
    this.resetIdleTimeout(run);

    const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        this.resetIdleTimeout(run);
        const nextText = selectPreferredTextSnapshot(run.text, data.text);
        const didTextChange = nextText !== run.text;
        run.text = nextText;
        if (!didTextChange) {
          return;
        }
        const rewritten = rewriteOpenClawMediaPaths(run.text, run.workspacePath);
        run.clients.forEach(res => {
          res.write(`data: ${JSON.stringify({ type: 'delta', text: rewritten })}\n\n`);
        });
      }
    };

    const onFinal = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
        if (terminalFinalText) {
          run.finalEventText = selectPreferredTextSnapshot(run.finalEventText, terminalFinalText);
          run.text = selectPreferredTextSnapshot(run.text, terminalFinalText);
        } else if (data.text) {
          run.text = selectPreferredTextSnapshot(run.text, data.text);
        }
        run.finalEventGeneration += 1;
        this.resetIdleTimeout(run);
        this.emitVisibleFinal(run, run.finalEventText || run.text);
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onAborted = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        if (data.text) {
          run.text = selectPreferredTextSnapshot(run.text, data.text);
        }
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onError = (data: { sessionKey: string; runId: string; error: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        this.failRun(run, data.error);
      }
    };

    const onDisconnect = () => {
      onError({ sessionKey: sessionId, runId, error: CHAT_GATEWAY_DISCONNECTED_DETAIL });
    };

    clientRef.on('chat.delta', onDelta);
    clientRef.on('chat.final', onFinal);
    clientRef.on('chat.aborted', onAborted);
    clientRef.on('chat.error', onError);
    clientRef.on('disconnected', onDisconnect);

    // Attach listeners to run for easy cleanup
    (run as any)._onDelta = onDelta;
    (run as any)._onFinal = onFinal;
    (run as any)._onAborted = onAborted;
    (run as any)._onError = onError;
    (run as any)._onDisconnect = onDisconnect;

    this.scheduleCompletionProbe(run);

    return run;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean }) {
    const run = this.runs.get(sessionId);
    if (run) {
      run.clients.push(res);
      if (options?.announceAttach) {
        res.write(`data: ${JSON.stringify({
          type: 'attached',
          messageId: run.messageId,
          agentId: run.agentId,
          agentName: run.agentName,
          modelUsed: run.modelUsed,
        })}\n\n`);
      }
      if (run.visibleFinalText) {
        res.write(`data: ${JSON.stringify({ type: 'final', text: run.visibleFinalText })}\n\n`);
      } else if (run.text) {
        // Immediately send current accumulated text
        const rewritten = rewriteOpenClawMediaPaths(run.text, run.workspacePath);
        res.write(`data: ${JSON.stringify({ type: 'delta', text: rewritten })}\n\n`);
      }
      res.on('close', () => {
        run.clients = run.clients.filter(c => c !== res);
      });
      return true;
    }
    return false;
  }

  private resetIdleTimeout(run: ActiveRun) {
    if (run.idleTimeout) clearTimeout(run.idleTimeout);
    run.idleTimeout = setTimeout(() => {
      const errorMsg = run.text ? 'Response interrupted (idle timeout).' : 'Response timed out (no connection).';
      const finalText = run.text || errorMsg;
      const rewritten = rewriteOpenClawMediaPaths(finalText, run.workspacePath);
      
      this.db.updateMessage(run.messageId, rewritten, run.modelUsed);
      this.emitVisibleFinal(run, finalText, { end: true });
      this.cleanupRun(run.sessionId);
    }, 600000); // 10 minutes
  }

  private matchesRunEvent(run: ActiveRun, sessionKey: string, runId?: string | null) {
    if (runId && runId !== run.runId) {
      return false;
    }
    return sessionKey === run.finalSessionKey
      || sessionKey === run.sessionId
      || sessionKey.endsWith(`:${run.sessionId}`)
      || sessionKey.includes(`:chat:${run.sessionId}`);
  }

  private scheduleCompletionProbe(run: ActiveRun, delay = CHAT_STREAM_COMPLETION_PROBE_DELAY_MS) {
    if (!this.runs.has(run.sessionId)) return;
    run.completionProbePending = true;
    if (run.completionProbeTimer) {
      clearTimeout(run.completionProbeTimer);
    }
    run.completionProbeTimer = setTimeout(() => {
      run.completionProbeTimer = undefined;
      if (run.completionProbeInFlight) {
        return;
      }
      run.completionProbePending = false;
      void this.probeCompletion(run);
    }, delay);
  }

  private async probeCompletion(run: ActiveRun) {
    if (!this.runs.has(run.sessionId) || run.completionProbeInFlight || !run.clientRef) {
      return;
    }

    run.completionProbeInFlight = true;
    const probeFinalGeneration = run.finalEventGeneration;

    try {
      await run.clientRef.waitForRun(run.runId, CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
      if (run.firstCompletionWaitResolvedAt === undefined) {
        run.firstCompletionWaitResolvedAt = Date.now();
      }
      if (!this.runs.has(run.sessionId)) return;

      let completedOutput = selectPreferredTextSnapshot(run.text, run.finalEventText);
      let settledErrorDetail = '';
      let shouldRetryForEmptyCompletion = false;
      let sawSettledAssistantText = false;
      let bestSettledAssistantText = '';
      try {
        const historyProbeStartedAt = Date.now();
        while ((Date.now() - historyProbeStartedAt) < CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
          const history = await run.clientRef.getChatHistory(run.finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
          const settledAssistantOutcome = extractSettledAssistantOutcome(history, run.historySnapshot);
          if (settledAssistantOutcome.kind === 'error') {
            settledErrorDetail = settledAssistantOutcome.error;
            break;
          }
          if (settledAssistantOutcome.kind === 'text') {
            sawSettledAssistantText = true;
            bestSettledAssistantText = settledAssistantOutcome.text;
            const settledMatchesCurrent = settledAssistantOutcome.text.trim() === completedOutput.trim();
            if (shouldPreferSettledAssistantText(completedOutput, settledAssistantOutcome.text)) {
              completedOutput = selectPreferredTextSnapshot(completedOutput, settledAssistantOutcome.text);
              break;
            }
            if (settledMatchesCurrent) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS));
        }

        if (settledErrorDetail) {
          this.failRun(run, settledErrorDetail);
          return;
        }

        if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
          completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
        }
      } catch (historyError) {
        console.warn(`[ActiveRunManager] Failed to read final history for session ${run.sessionId}, run ${run.runId}:`, historyError);
        shouldRetryForEmptyCompletion = true;
      }

      if (!completedOutput.trim()) {
        shouldRetryForEmptyCompletion = true;
      }

      completedOutput = selectPreferredTextSnapshot(completedOutput, run.finalEventText);

      const hasSettledAssistantText = bestSettledAssistantText.trim().length > 0;

      if (
        probeFinalGeneration > 0
        && probeFinalGeneration === run.finalEventGeneration
        && hasSettledAssistantText
      ) {
        run.settledCalibrationGeneration = Math.max(run.settledCalibrationGeneration, probeFinalGeneration);
      }

      const isAwaitingInitialTerminalEvidence = run.finalEventGeneration === 0 && !hasSettledAssistantText;
      const isAwaitingSettledFinalCalibration = run.finalEventGeneration > run.settledCalibrationGeneration;

      if (
        shouldRetryForEmptyCompletion
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        (isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (isAwaitingInitialTerminalEvidence) {
        this.failRun(run, 'Run completed without a terminal assistant response.');
        return;
      }

      if (isAwaitingSettledFinalCalibration) {
        this.failRun(run, 'Run completed but the final assistant response never settled.');
        return;
      }

      this.finalizeRun(run, completedOutput);
    } catch (error: any) {
      if (!this.runs.has(run.sessionId)) return;
      const detail = typeof error?.message === 'string' ? error.message : '';
      if (/timeout/i.test(detail)) {
        this.scheduleCompletionProbe(run);
        return;
      }
      this.failRun(run, detail || 'Failed waiting for run completion.');
    } finally {
      run.completionProbeInFlight = false;
      if (this.runs.has(run.sessionId) && run.completionProbePending && !run.completionProbeTimer) {
        this.scheduleCompletionProbe(run, 0);
      }
    }
  }

  private finalizeRun(run: ActiveRun, finalText: string) {
    if (!this.runs.has(run.sessionId)) return;

    let protectedFinalText = selectPreferredTextSnapshot(run.text, finalText);
    protectedFinalText = selectPreferredTextSnapshot(protectedFinalText, run.finalEventText);
    if (protectedFinalText) {
      run.text = protectedFinalText;
    }
    const rewritten = rewriteOpenClawMediaPaths(protectedFinalText || run.text, run.workspacePath);
    if (!rewritten.trim()) {
      this.failRun(run, 'No text output returned from the run.');
      return;
    }

    this.db.updateMessage(run.messageId, rewritten, run.modelUsed);
    this.emitVisibleFinal(run, protectedFinalText || run.text, { end: true });
    this.cleanupRun(run.sessionId);
  }

  private failRun(run: ActiveRun, detail: string) {
    if (!this.runs.has(run.sessionId)) return;

    const structuredError = createStructuredChatError(detail);

    this.db.updateMessage(run.messageId, structuredError.content, run.modelUsed);
    this.db.updateMessageEnvelope(run.messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);

    run.clients.forEach(res => {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: structuredError.content,
        messageCode: structuredError.messageCode,
        messageParams: structuredError.messageParams,
        rawDetail: structuredError.rawDetail,
        role: structuredError.role,
      })}\n\n`);
      res.end();
    });
    this.cleanupRun(run.sessionId);
  }

  private cleanupRun(sessionId: string) {
    const run = this.runs.get(sessionId);
    if (run) {
      if (run.idleTimeout) clearTimeout(run.idleTimeout);
      if (run.completionProbeTimer) clearTimeout(run.completionProbeTimer);
      if (run.clientRef) {
        if ((run as any)._onDelta) run.clientRef.off('chat.delta', (run as any)._onDelta);
        if ((run as any)._onFinal) run.clientRef.off('chat.final', (run as any)._onFinal);
        if ((run as any)._onAborted) run.clientRef.off('chat.aborted', (run as any)._onAborted);
        if ((run as any)._onError) run.clientRef.off('chat.error', (run as any)._onError);
        if ((run as any)._onDisconnect) run.clientRef.off('disconnected', (run as any)._onDisconnect);
      }
      this.runs.delete(sessionId);
    }
  }
}

const activeRunManager = new ActiveRunManager(db);

function getLatestChatRegenerateTarget(sessionId: string): {
  latestUserMessage: ChatRow | null;
  latestReplyMessage: ChatRow | null;
} {
  const recentHistory = db.getMessages(sessionId, CHAT_REGENERATE_LOOKBACK_LIMIT);
  let latestReplyMessage: ChatRow | null = null;

  for (let index = recentHistory.length - 1; index >= 0; index -= 1) {
    const message = recentHistory[index];
    if (message.role === 'assistant' || message.role === 'system') {
      if (!latestReplyMessage) latestReplyMessage = message;
      continue;
    }

    return {
      latestUserMessage: message,
      latestReplyMessage,
    };
  }

  return {
    latestUserMessage: null,
    latestReplyMessage,
  };
}

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, parentId } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId or message'));
  }

  let userMsgId: number | undefined;
  let assistantMsgId: number | undefined;

  try {
    const sessionInfo = sessionManager.getSession(sessionId);
    let finalMessage = String(message);

    if (sessionInfo) {
      const history = db.getMessages(sessionId, 1);
      let injectedInstructions = '';
      if (history.length === 0 && sessionInfo.prompt) {
        injectedInstructions += `${sessionInfo.prompt}\n\n`;
      }
      if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
        injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
      }
      
      if (injectedInstructions) {
        finalMessage = `${injectedInstructions}${finalMessage}`;
      }
    }

    let finalParentId = parentId ? Number(parentId) : undefined;
    if (finalParentId === undefined) {
      const history = db.getMessages(sessionId, 1);
      finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
    }

    userMsgId = Number(db.saveMessage({ session_key: sessionId, parent_id: finalParentId, role: 'user', content: String(message) }));
    const client = await getConnection(sessionId);
    const agentId = sessionInfo?.agentId || 'main';

    const allCharacters = db.getCharacters();
    const character = allCharacters.find(c => c.agentId === agentId);
    const agentName = sessionInfo?.name || character?.name || agentId;
    const modelUsed = agentProvisioner.readAgentModel(agentId) ||
      agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    const outgoingMessage = rewriteOutgoingMessage(finalMessage, agentId);

    assistantMsgId = Number(db.saveMessage({
      session_key: sessionId,
      parent_id: userMsgId,
      role: 'assistant',
      content: '', // empty initially
      model_used: modelUsed,
      agent_id: agentId,
      agent_name: agentName
    }));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Notify frontend of the real DB IDs immediately
    res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
    res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId, assistantMsgId })}\n\n`);

    const expectedSessionKey = sessionId.startsWith('agent:')
      ? sessionId
      : `agent:${agentId}:chat:${sessionId}`;
    const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
      .then((history) => getHistorySnapshot(history))
      .catch(() => ({ length: 0, latestSignature: '' }));

    const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
      sessionKey: sessionId,
      message: outgoingMessage.text,
      agentId: agentId,
      attachments: outgoingMessage.attachments,
    });

    const run = activeRunManager.startRun(
      sessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      assistantMsgId,
      getSessionWorkspacePath(sessionId),
      client,
      finalSessionKey,
      preRunHistorySnapshot
    );
    
    activeRunManager.attachClient(sessionId, res);

  } catch (error: any) {
    const structuredError = createStructuredChatError(error?.message);
    const sessionInfo = db.getSession(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const character = db.getCharacters().find(c => c.agentId === agentId);
    const modelUsed = agentProvisioner.readAgentModel(agentId) || agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    if (typeof assistantMsgId === 'number') {
      try {
        db.updateMessage(assistantMsgId, structuredError.content, modelUsed);
        db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
      } catch {}
    } else if (typeof userMsgId === 'number') {
      try {
        assistantMsgId = Number(db.saveMessage({
          session_key: sessionId,
          parent_id: userMsgId,
          role: structuredError.role,
          content: structuredError.content,
          model_used: modelUsed,
          agent_id: structuredError.agent_id,
          agent_name: structuredError.agent_name,
        }));
      } catch {}
    }

    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(error?.message));
    } else {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: structuredError.content,
        messageCode: structuredError.messageCode,
        messageParams: structuredError.messageParams,
        rawDetail: structuredError.rawDetail,
        role: structuredError.role,
      })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/chat/regenerate', async (req, res) => {
  const { sessionId, message, parentId } = req.body;

  if (!sessionId || !message || !parentId) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId, message, or parentId'));
  }

  let assistantMsgId: number | undefined;

  try {
    const numericParentId = Number(parentId);
    const { latestUserMessage, latestReplyMessage } = getLatestChatRegenerateTarget(sessionId);
    const latestUserId = Number(latestUserMessage?.id);
    const latestReplyParentId = Number(latestReplyMessage?.parent_id);
    const hasConflictingLatestReply =
      !!latestReplyMessage
      && Number.isFinite(latestUserId)
      && Number.isFinite(latestReplyParentId)
      && latestReplyParentId !== numericParentId;

    if (
      !Number.isFinite(numericParentId)
      || !latestUserMessage
      || latestUserId !== numericParentId
      || hasConflictingLatestReply
    ) {
      return res.status(409).json(buildStructuredChatHttpError('Regenerate is only allowed for the latest assistant reply.'));
    }

    if (
      latestReplyMessage
      && (latestReplyMessage.role === 'assistant' || latestReplyMessage.role === 'system')
      && latestReplyParentId === numericParentId
      && typeof latestReplyMessage.id === 'number'
    ) {
      db.deleteMessage(Number(latestReplyMessage.id));
    }

    const sessionInfo = sessionManager.getSession(sessionId);
    let finalMessage = String(message);

    if (sessionInfo) {
      const history = db.getMessages(sessionId, 1);
      let injectedInstructions = '';
      if (history.length === 0 && sessionInfo.prompt) {
        injectedInstructions += `${sessionInfo.prompt}\n\n`;
      }
      if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
        injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
      }
      
      if (injectedInstructions) {
        finalMessage = `${injectedInstructions}${finalMessage}`;
      }
    }

    const client = await getConnection(sessionId);
    const agentId = sessionInfo?.agentId || 'main';

    const allCharacters = db.getCharacters();
    const character = allCharacters.find(c => c.agentId === agentId);
    const agentName = sessionInfo?.name || character?.name || agentId;
    const modelUsed = agentProvisioner.readAgentModel(agentId) ||
      agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    const outgoingMessage = rewriteOutgoingMessage(finalMessage, agentId);

    assistantMsgId = Number(db.saveMessage({
      session_key: sessionId,
      parent_id: numericParentId,
      role: 'assistant',
      content: '', 
      model_used: modelUsed,
      agent_id: agentId,
      agent_name: agentName
    }));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    
    // Notify frontend immediately of the new assistant msg ID
    res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
    res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId: numericParentId, assistantMsgId })}\n\n`);

    const expectedSessionKey = sessionId.startsWith('agent:')
      ? sessionId
      : `agent:${agentId}:chat:${sessionId}`;
    const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
      .then((history) => getHistorySnapshot(history))
      .catch(() => ({ length: 0, latestSignature: '' }));

    const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
      sessionKey: sessionId,
      message: outgoingMessage.text,
      agentId: agentId,
      attachments: outgoingMessage.attachments,
    });

    const run = activeRunManager.startRun(
      sessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      assistantMsgId,
      getSessionWorkspacePath(sessionId),
      client,
      finalSessionKey,
      preRunHistorySnapshot
    );
    
    activeRunManager.attachClient(sessionId, res);

  } catch (error: any) {
    const structuredError = createStructuredChatError(error?.message);
    const sessionInfo = db.getSession(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const modelUsed = agentProvisioner.readAgentModel(agentId) || agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    if (typeof assistantMsgId === 'number') {
      try {
        db.updateMessage(assistantMsgId, structuredError.content, modelUsed);
        db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
      } catch {}
    } else {
      try {
        assistantMsgId = Number(db.saveMessage({
          session_key: sessionId,
          parent_id: Number(parentId),
          role: structuredError.role,
          content: structuredError.content,
          model_used: modelUsed,
          agent_id: structuredError.agent_id,
          agent_name: structuredError.agent_name,
        }));
      } catch {}
    }

    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(error?.message));
    } else {
      res.write(`data: ${JSON.stringify({
        type: 'error',
        text: structuredError.content,
        messageCode: structuredError.messageCode,
        messageParams: structuredError.messageParams,
        rawDetail: structuredError.rawDetail,
        role: structuredError.role,
      })}\n\n`);
      res.end();
    }
  }
});

app.get('/api/chat/attach/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  const run = activeRunManager.getRun(sessionId);
  if (!run) {
    // Return empty payload to indicate no active run
    return res.status(200).json({ active: false });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  activeRunManager.attachClient(sessionId, res, { announceAttach: true });
});

app.post('/api/chat/stop', async (req, res) => {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId'));
  }

  try {
    const result = await activeRunManager.abortRun(String(sessionId));
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to stop chat run.'));
  }
});

app.post('/api/chat/silent', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  try {
    const client = await getConnection(sessionId);
    const rawResponse = await client.sendChatMessage({ sessionKey: sessionId, message });
    // Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
    const response = rewriteOpenClawMediaPaths(rawResponse, getSessionWorkspacePath(sessionId));
    // Note: We intentionally DO NOT save to DB here
    res.json({ success: true, response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// file upload (doc/image/video/audio), supports multiple files
app.post('/api/files/upload', (req, res) => {
  upload.array('files', 20)(req, res, async (error) => {
    if (error) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Upload failed' });
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

    const uploadTarget = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
    const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images (OpenClaw has 5MB limit)

    const saved = await Promise.all(files.map(async (f) => {
      let finalSize = f.size;

      if (f.mimetype.startsWith('image/')) {
        try {
          const originalBuffer = fs.readFileSync(f.path);
          const metadata = await sharp(originalBuffer).metadata();
          let width = metadata.width || 2048;
          let height = metadata.height || 2048;
          const maxDimension = 2048;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height / width) * maxDimension);
              width = maxDimension;
            } else {
              width = Math.round((width / height) * maxDimension);
              height = maxDimension;
            }
          }

          let quality = 80;

          while (quality >= 10) {
            const nextBuffer = await sharp(originalBuffer)
              .resize(width, height, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality, mozjpeg: true })
              .toBuffer();

            if (nextBuffer.length <= IMAGE_TARGET_SIZE || quality <= 10) {
              fs.writeFileSync(f.path, nextBuffer);
              finalSize = nextBuffer.length;
              break;
            }

            quality -= 10;
          }
        } catch (err) {
          console.error('[Upload] Image compression failed:', err);
        }
      }

      db.saveFile({
        sessionKey: uploadTarget.sessionKey,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: finalSize,
        storedPath: f.path,
      });

      return {
        name: f.originalname,
        mimeType: f.mimetype,
        size: finalSize,
        url: `/uploads/${path.basename(f.path)}`,
      };
    }));

    res.json({
      success: true,
      files: saved,
    });
  });
});

app.get('/api/files', (_req, res) => {
  res.json({ success: true, files: db.getFiles(300) });
});

app.get('/api/commands', (_req, res) => {
  const commands = db.getQuickCommands();
  res.json({ success: true, commands });
});

app.post('/api/commands', (req, res) => {
  const { command, description } = req.body;
  if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
  try {
    db.saveQuickCommand(command, description);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/commands/:id', (req, res) => {
  const { command, description } = req.body;
  const { id } = req.params;
  if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
  try {
    db.updateQuickCommand(Number(id), command, description);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/commands/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.deleteQuickCommand(Number(id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // 1. Try to find in database (to support agent workspaces)
  const fileInfo = db.getFileByStoredName(filename);
  if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
    return res.sendFile(fileInfo.stored_path);
  }

  // 2. Fallback to global upload dir
  const globalPath = path.join(uploadDir, filename);
  if (fs.existsSync(globalPath)) {
    return res.sendFile(globalPath);
  }

  res.status(404).send('File not found');
});


// Serve OpenClaw files (workspaces, media, etc.)
app.use('/openclaw', express.static(path.join(process.env.HOME || '', '.openclaw')));

// Securely serve arbitrary local files via base64 encoded paths
app.get('/api/files/download', (req, res) => {
  const b64Path = req.query.path as string;
  const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
  if (!b64Path) {
    return res.status(400).send('Missing path parameter');
  }

  try {
    const absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');
    
    // Basic security check: ensure it's an absolute path
    if (!path.isAbsolute(absolutePath)) {
      return res.status(403).send('Only absolute paths are allowed');
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).send('File not found');
    }

    const filename = path.basename(absolutePath);
    // Allow inline responses for preview while keeping attachment as the default download behavior.
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.sendFile(absolutePath);
  } catch (error: any) {
    console.error(`[Download Error] ${error.message}`);
    res.status(500).send('Failed to serve file');
  }
});

// File preview capabilities
app.get('/api/files/capabilities', (_req, res) => {
  res.json({ libreoffice: hasLibreOffice });
});

function resolvePreviewAbsolutePath(req: express.Request): string {
  let absolutePath = '';
  const b64Path = req.query.path as string | undefined;
  const filenameParam = req.query.filename as string | undefined;

  if (b64Path) {
    absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('Only absolute paths are allowed');
    }
    return absolutePath;
  }

  if (filenameParam) {
    const decodedFilename = decodeURIComponent(filenameParam);
    const fileInfo = db.getFileByStoredName(decodedFilename);
    if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
      return fileInfo.stored_path;
    }

    const globalPath = path.join(uploadDir, decodedFilename);
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }
  }

  return '';
}

async function ensureConvertedPreviewPdf(absolutePath: string): Promise<string> {
  if (!hasLibreOffice) {
    throw new Error('LibreOffice not available');
  }

  const crypto = require('crypto');
  const stat = fs.statSync(absolutePath);
  const cacheKey = crypto.createHash('md5').update(`${absolutePath}:${stat.mtimeMs}`).digest('hex');
  const cachedPdf = path.join(previewCacheDir, `${cacheKey}.pdf`);

  if (fs.existsSync(cachedPdf)) {
    return cachedPdf;
  }

  const tmpDir = path.join(previewCacheDir, cacheKey);
  fs.mkdirSync(tmpDir, { recursive: true });

  await execPromise(
    `libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${absolutePath}"`,
    { timeout: 30000 }
  );

  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.pdf'));
  if (files.length === 0) {
    throw new Error('LibreOffice conversion produced no PDF output');
  }

  const outputPdf = path.join(tmpDir, files[0]);
  fs.renameSync(outputPdf, cachedPdf);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return cachedPdf;
}

app.get('/api/files/preview-data', async (req, res) => {
  try {
    const mode = req.query.mode === 'converted' ? 'converted' : 'source';
    const absolutePath = resolvePreviewAbsolutePath(req);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const servedPath = mode === 'converted'
      ? await ensureConvertedPreviewPdf(absolutePath)
      : absolutePath;

    const buffer = fs.readFileSync(servedPath);
    res.json({
      filename: path.basename(servedPath),
      data: buffer.toString('base64'),
      mimeType: mode === 'converted' ? 'application/pdf' : undefined,
    });
  } catch (error: any) {
    console.error(`[Preview Data Error] ${error.message}`);
    if (error.message === 'Only absolute paths are allowed') {
      return res.status(403).json({ error: error.message });
    }
    if (error.message === 'LibreOffice not available') {
      return res.status(501).json({ error: error.message, fallback: true });
    }
    res.status(500).json({ error: 'Preview data failed', message: error.message });
  }
});

app.get('/api/files/preview', async (req, res) => {
  try {
    const mode = req.query.mode === 'source' ? 'source' : 'converted';
    const absolutePath = resolvePreviewAbsolutePath(req);

    if (!absolutePath) {
      return res.status(404).send('File not found');
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).send('File not found');
    }

    const filename = path.basename(absolutePath);

    if (mode === 'source') {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return res.sendFile(absolutePath);
    }

    if (!hasLibreOffice) {
      return res.status(501).json({ error: 'LibreOffice not available', fallback: true });
    }

    const cachedPdf = await ensureConvertedPreviewPdf(absolutePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(cachedPdf))}`);
    res.sendFile(cachedPdf);
  } catch (error: any) {
    console.error(`[Preview Error] ${error.message}`);
    if (error.message === 'Only absolute paths are allowed') {
      return res.status(403).send(error.message);
    }
    res.status(500).json({ error: 'Preview conversion failed', message: error.message });
  }
});

// Serve hashed static assets with long-lived cache (JS/CSS filenames include content hash)
app.use('/assets', express.static(path.join(__dirname, '../../frontend/dist/assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Serve other static files (images, favicon, manifest, etc.) with short cache
app.use(express.static(path.join(__dirname, '../../frontend/dist'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // index.html must NEVER be cached by proxies — always revalidate
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ========== Group Chat Engine ==========
const groupChatEngine = new GroupChatEngine(db, getConnection, (agentId) => {
  // First, check if there's a custom session for this agent
  const sessions = sessionManager.getAllSessions();
  const session = sessions.find((s: any) => s.agentId === agentId);
  if (session) {
    const customModel = agentProvisioner.readAgentModel(agentId);
    if (customModel) return customModel;
  }
  
  // Fallback to characters table for hardcoded system agents
  const chars = db.getCharacters();
  const c = chars.find(x => x.agentId === agentId);
  return c?.model || '';
}, prepareGroupRuntimeAgent);

// SSE clients per group
const groupSSEClients = new Map<string, Set<express.Response>>();

groupChatEngine.on('message', (msg: any) => {
  const clients = groupSSEClients.get(msg.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'message',
      data: withStructuredGroupMessage(msg, { groupId: msg.groupId }),
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('delete', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'delete', id: info.id, parent_id: info.parent_id ?? null });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('delta', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'delta',
      ...info,
      content: typeof info.content === 'string'
        ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
        : info.content,
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('edit', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'edit',
      ...info,
      content: typeof info.content === 'string'
        ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
        : info.content,
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('typing', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'typing', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('typing_done', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'typing_done', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('run_state', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'run_state', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

// --- Group Chat CRUD ---
app.get('/api/groups', (_req, res) => {
  try {
    const groups = db.getGroupChats();
    // Attach members to each group
    const result = groups.map(g => ({
      ...g,
      members: db.getGroupMembers(g.id).map(withResolvedGroupMemberDisplayName),
    }));
    res.json({ success: true, groups: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups', (req, res) => {
  let persistedGroupId: string | null = null;
  try {
    const { id: rawId, name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const validation = validateGroupId(rawId);
    if (validation.issue === 'required') {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_REQUIRED_ERROR_CODE));
    }
    if (validation.issue === 'whitespace') {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE));
    }
    if (validation.issue) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_INVALID_ERROR_CODE, null, {
        groupId: validation.normalizedId || String(rawId || ''),
      }));
    }

    const id = validation.normalizedId;
    if (db.getGroupChat(id)) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, { groupId: id }));
    }

    const now = new Date().toISOString();
    const allGroups = db.getGroupChats();
    const maxPosition = allGroups.length > 0 ? Math.max(...allGroups.map((group) => group.position || 0)) : -1;
    db.saveGroupChat({
      id,
      name,
      description: description || '',
      system_prompt: system_prompt || '',
      process_start_tag: process_start_tag || '',
      process_end_tag: process_end_tag || '',
      max_chain_depth: max_chain_depth !== undefined ? max_chain_depth : 6,
      position: maxPosition + 1,
      created_at: now,
      updated_at: now,
    });
    persistedGroupId = id;

    // Save members
    if (Array.isArray(members)) {
      members.forEach((m: any, idx: number) => {
        db.saveGroupMember({
          id: `gm_${id}_${m.agentId}`,
          group_id: id,
          agent_id: m.agentId,
          display_name: m.displayName || m.agentId,
          role_description: m.roleDescription || '',
          position: idx,
        });
      });
    }

    ensureGroupWorkspace(id);
    res.json({ success: true, id });
  } catch (err: any) {
    if (/UNIQUE constraint failed: group_chats\.id|PRIMARY KEY/i.test(String(err?.message || ''))) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, {
        groupId: typeof req.body?.id === 'string' ? req.body.id.trim() : '',
      }));
    }
    if (persistedGroupId) {
      try {
        db.deleteGroupChat(persistedGroupId);
        deleteGroupWorkspace(persistedGroupId);
      } catch {}
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/groups/:id', (req, res) => {
  try {
    const existing = db.getGroupChat(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Group not found' });

    const { name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
    db.saveGroupChat({
      ...existing,
      name: name ?? existing.name,
      description: description ?? existing.description,
      system_prompt: system_prompt ?? existing.system_prompt,
      process_start_tag: process_start_tag ?? existing.process_start_tag,
      process_end_tag: process_end_tag ?? existing.process_end_tag,
      max_chain_depth: max_chain_depth ?? existing.max_chain_depth ?? 6,
      position: existing.position ?? 0,
      updated_at: new Date().toISOString(),
    });

    // Replace members if provided
    if (Array.isArray(members)) {
      db.deleteGroupMembers(req.params.id);
      members.forEach((m: any, idx: number) => {
        db.saveGroupMember({
          id: `gm_${req.params.id}_${m.agentId}`,
          group_id: req.params.id,
          agent_id: m.agentId,
          display_name: m.displayName || m.agentId,
          role_description: m.roleDescription || '',
          position: idx,
        });
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'Invalid ids format' });
  }

  try {
    db.updateGroupChatPositions(ids.map((id: string, index: number) => ({ id, position: index })));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    try {
      await groupChatEngine.abortGroupRun(req.params.id);
    } catch {}
    clearStoredFilesBySessionKey(req.params.id);
    cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
    deleteGroupWorkspace(req.params.id);
    db.deleteGroupChat(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset group (clear history but keep group entity and members)
app.post('/api/groups/:id/reset', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    try {
      await groupChatEngine.abortGroupRun(req.params.id);
    } catch {}

    // Clear group messages
    db.deleteGroupMessagesByGroup(req.params.id);
    clearStoredFilesBySessionKey(req.params.id);
    cleanupGroupRuntimeAgent(req.params.id);
    resetGroupWorkspace(req.params.id);
    // Keep source agents intact; resetting a group should only clear group runtime clones.

    res.json({ success: true });
  } catch (err: any) {
    console.error('Failed to reset group:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Group Messages ---
app.get('/api/groups/:id/messages', async (req, res) => {
  try {
    await reconcileInactiveGroupLatestMessage(req.params.id);
    const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
    const result = db.getGroupMessagesPage(req.params.id, { beforeId, limit });
    res.json(buildHistoryPageResponse(
      result.rows.map((row) => withStructuredGroupMessage(row, { groupId: req.params.id })),
      result.pageInfo,
    ));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups/:id/active-run', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    const activeMessage = groupChatEngine.getGroupActiveRunMessage(req.params.id);
    if (!activeMessage) {
      const actions = await reconcileInactiveGroupLatestMessage(req.params.id);
      if (actions.length > 0) {
        broadcastGroupReconciliationActions(req.params.id, actions);
      }

      const latestMessage = db.getRecentGroupMessages(req.params.id, 1)[0];
      return res.json({
        success: true,
        active: false,
        message: latestMessage ? withStructuredGroupMessage(latestMessage, { groupId: req.params.id }) : null,
      });
    }

    res.json({
      success: true,
      active: true,
      message: withStructuredGroupMessage(activeMessage, { groupId: req.params.id }),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups/:id/messages/search', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(buildHistorySearchResponse(db.searchGroupMessages(req.params.id, query)));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/messages', async (req, res) => {
  try {
    const { content, parentId: rawParentId } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });

    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    if (groupChatEngine.isGroupProcessing(req.params.id)) {
      return res.status(409).json({
        ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE),
        runState: groupChatEngine.getGroupRunState(req.params.id),
      });
    }

    const parsedParentId = (
      typeof rawParentId === 'number' && Number.isFinite(rawParentId) && rawParentId > 0
        ? Math.floor(rawParentId)
        : typeof rawParentId === 'string' && rawParentId.trim()
          ? Number.parseInt(rawParentId, 10)
          : undefined
    );
    const parentId = Number.isFinite(parsedParentId as number) && (parsedParentId as number) > 0
      ? Number(parsedParentId)
      : undefined;

    // Respond immediately, processing happens async
    res.json({ success: true });

    // Process message in background
    (groupChatEngine as any).sendUserMessage(req.params.id, content, parentId).catch((err: any) => {
      console.error('[GroupChat] Error processing message:', err);
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/stop', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    const result = await groupChatEngine.abortGroupRun(req.params.id);
    const cleanedMessageIds: number[] = [];

    if (!result.aborted) {
      const recentMessages = db.getRecentGroupMessages(req.params.id, 20);
      const staleMessages = recentMessages.filter((message) => (
        message.sender_type === 'agent'
        && typeof message.content === 'string'
        && message.content.trim() === ''
      ));

      if (staleMessages.length > 0) {
        const clients = groupSSEClients.get(req.params.id);
        for (const staleMessage of staleMessages) {
          if (typeof staleMessage.id !== 'number') continue;
          db.deleteGroupMessage(staleMessage.id);
          cleanedMessageIds.push(staleMessage.id);
          if (clients) {
            const data = JSON.stringify({ type: 'delete', id: staleMessage.id, parent_id: staleMessage.parent_id ?? null });
            for (const client of clients) {
              try { client.write(`data: ${data}\n\n`); } catch {}
            }
          }
        }
      }
    }

    res.json({ success: true, aborted: result.aborted, cleanedMessageIds });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/groups/:id/messages/:msgId', (req, res) => {
  try {
    const { content } = req.body;
    db.updateGroupMessage(Number(req.params.msgId), content);
    res.json({ success: true });
    
    // Broadcast edit event
    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'edit', id: Number(req.params.msgId), content })}\n\n`);
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/groups/:id/messages/:msgId', (req, res) => {
  try {
    db.deleteGroupMessage(Number(req.params.msgId));
    res.json({ success: true });

    // Broadcast delete event
    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'delete', id: Number(req.params.msgId) })}\n\n`);
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/messages/regenerate', async (req, res) => {
  try {
    const { msgId } = req.body; // The message we want to regenerate
    if (!msgId) return res.status(400).json({ success: false, error: 'msgId required' });
    
    const targetMsg = db.getGroupMessageById(Number(msgId), req.params.id) as any;
    
    if (!targetMsg || targetMsg.sender_type !== 'agent' || !targetMsg.sender_id) {
       return res.status(400).json({ success: false, error: 'Cannot regenerate this message' });
    }

    // In linear group history, regenerate reuses the parent trigger message.
    let promptContext = "继续";
    let validParentId = targetMsg.parent_id || null;
    if (validParentId) {
       const triggerMsg = db.getGroupMessageById(validParentId) as any;
       if (triggerMsg) {
         promptContext = triggerMsg.content;
       } else {
         validParentId = null; // SAFEGUARD: Prevent FOREIGN KEY constraint fail if parent is orphaned
       }
    }

    db.deleteGroupMessage(Number(msgId));
    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'delete', id: Number(msgId), parent_id: validParentId })}\n\n`);
      });
    }

    res.json({ success: true });

    // Inform engine to resend request as a sibling response
    const groupName = db.getGroupChat(req.params.id)?.name || '团队';
    // Emulate a new trigger directly targeting that agent without advancing depth too quickly, using promptContext
    (groupChatEngine as any).sendToAgent(req.params.id, groupName, targetMsg.sender_id, promptContext, targetMsg.sender_name || 'Agent', 0, validParentId || undefined).catch((err: any) => {
      console.error('[GroupChat] Error regenerating message:', err);
    });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE endpoint for real-time updates
app.get('/api/groups/:id/events', async (req, res) => {
  const groupId = req.params.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('retry: 1000\n\n');
  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'run_state', data: groupChatEngine.getGroupRunState(groupId) })}\n\n`);

  const keepaliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {}
  }, GROUP_SSE_KEEPALIVE_MS);

  if (!groupSSEClients.has(groupId)) {
    groupSSEClients.set(groupId, new Set());
  }
  groupSSEClients.get(groupId)!.add(res);

  try {
    const actions = await reconcileInactiveGroupLatestMessage(groupId);
    broadcastGroupReconciliationActions(groupId, actions);
  } catch (error) {
    console.warn(`[GroupEvents] Failed to reconcile group ${groupId} on SSE connect:`, error);
  }

  req.on('close', () => {
    clearInterval(keepaliveTimer);
    groupSSEClients.get(groupId)?.delete(res);
    if (groupSSEClients.get(groupId)?.size === 0) {
      groupSSEClients.delete(groupId);
    }
  });
});

// Fallback for SPA — also no-cache
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

// Error handling
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Express error:', err);
  if (isStructuredRequestError(err)) {
    return res.status(err.status).json(err.payload);
  }
  res.status(500).json({ success: false, error: err.message });
});

// Start server
const PORT = Number(process.env.PORT) || 3100;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ClawUI backend listening on http://0.0.0.0:${PORT}`);
});
