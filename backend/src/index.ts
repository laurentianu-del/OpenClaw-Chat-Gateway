import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import multer from 'multer';
import { WebSocket } from 'ws';
import OpenClawClient from './openclaw-client';
import SessionManager from './session-manager';
import ConfigManager from './config-manager';
import DB from './db';
import AgentProvisioner from './agent-provisioner';
import { exec } from 'child_process';
import util from 'util';
import net from 'net';

const execPromise = util.promisify(exec);

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
  destination: (_req, _file, cb) => {
    const config = configManager.getConfig();
    const sessionId = _req.body?.sessionId || '';
    const sessionInfo = sessionManager.getSession(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const workspacePath = agentProvisioner.getWorkspacePath(agentId);
    
    const finalUploadDir = path.join(workspacePath, 'uploads');
    console.log(`[Upload] Session: ${sessionId}, Agent: ${agentId}, Path: ${finalUploadDir}`);
    try {
      fs.mkdirSync(finalUploadDir, { recursive: true });
    } catch (err) {
      console.error(`[Upload] Failed to use workspace for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    cb(null, finalUploadDir);
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

// Ensure main agent workspace is registered in openclaw.json at startup
const mainRegistered = agentProvisioner.ensureMainAgent();
if (mainRegistered) {
  console.log('[Startup] Main agent workspace registered in openclaw.json');
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

// Store active OpenClaw connections
// Helper to rewrite outgoing messages: expand /uploads/ markdown links to absolute paths
function rewriteOutgoingMessage(message: string, agentId: string): string {
  const workspacePath = agentProvisioner.getWorkspacePath(agentId);
  const absoluteUploadsDir = path.join(workspacePath, 'uploads');

  // Regex to find markdown links like [name](/uploads/filename) or ![name](/uploads/filename)
  // or naked /uploads/filename if not in markdown
  return message.replace(/(\(?\/uploads\/)([^\s)]+)(\)?)/g, (match, prefix, filename, suffix) => {
    const absolutePath = path.join(absoluteUploadsDir, filename);
    return `${prefix.startsWith('(') ? '(' : ''}${absolutePath}${suffix.endsWith(')') ? ')' : ''}`;
  });
}

const connections = new Map<string, OpenClawClient>();

// Rewrite absolute local file paths in AI responses to HTTP-accessible download URLs
function rewriteOpenClawMediaPaths(text: string): string {
  // Match absolute Unix paths, stopping at whitespace, Markdown punct, or Chinese brackets/parens
  // \uff08\uff09 = （） \u3010\u3011 = 【】 \u300a\u300b = 《》
  const regex = /(\/(?:[^\s\)\]\u0022\u0027\u0060|<>\uff08\uff09\u3010\u3011\u300a\u300b\u300c\u300d]+))/g;
  
  return text.replace(regex, (match, _p1, offset) => {
    // Must have at least 2 path segments (e.g. /home/something) to avoid matching things like /api
    if (match.split('/').length < 3) return match;
    // Must have a file extension to be considered a downloadable file
    const ext = path.extname(match);
    if (!ext) return match;
    // Skip URLs: check both the match content and surrounding context
    if (match.includes('://')) return match;
    // Skip if this is part of a URL (preceded by ":" from a scheme like https: or http:)
    if (offset > 0 && text[offset - 1] === ':') return match;
    
    try {
      const encodedPath = Buffer.from(match).toString('base64');
      const filename = path.basename(match);
      return `\n\n[${filename}](/api/files/download?path=${encodeURIComponent(encodedPath)})\n\n`;
    } catch {
      return match;
    }
  });
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
app.get('/api/system/check-update', async (_req, res) => {
  try {
    const response = await axios.get('https://api.github.com/repos/liandu2024/OpenClaw-Chat-Gateway/releases/latest', {
      timeout: 10000,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OpenClaw-Chat-Gateway-ClawUI'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('[UpdateCheck] Failed to fetch latest release:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch update info from GitHub' });
  }
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
    openclawWorkspace: config.openclawWorkspace || '',
  });
});

app.post('/api/config', (req, res) => {
  configManager.setConfig(req.body);
  res.json({ success: true });
});

import crypto from 'crypto';

function generateAuthToken(password: string): string {
  return crypto.createHash('sha256').update(password + '_clawui_salt').digest('hex');
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
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

app.get('/api/gateway/status', async (_req, res) => {
  const config = configManager.getConfig();
  if (!config.gatewayUrl) {
    return res.json({ connected: false, message: 'Gateway URL not configured' });
  }

  try {
    const client = new OpenClawClient({ 
      gatewayUrl: config.gatewayUrl, 
      token: config.token, 
      password: config.password 
    });
    client.on('error', () => {});
    await client.connect();
    client.disconnect();
    res.json({ connected: true });
  } catch (error: any) {
    res.json({ connected: false, message: error?.message || 'Connection failed' });
  }
});

app.post('/api/config/test', async (req, res) => {
  const { gatewayUrl, token, password } = req.body;

  if (!gatewayUrl) {
    return res.status(400).json({ success: false, message: 'Gateway URL is required' });
  }

  try {
    const client = new OpenClawClient({ gatewayUrl, token, password });
    client.on('error', () => { /* Prevent unhandled event crash */ });
    
    // Attempt to connect and authenticate
    await client.connect();
    
    // If we reach here, connection and authentication succeeded
    client.disconnect();
    res.json({ success: true, message: 'Connection successful' });
  } catch (error: any) {
    res.json({ success: false, message: error?.message || 'Connection failed' });
  }
});

app.get('/api/config/detect-workspace', (req, res) => {
  const mainWorkspace = agentProvisioner.getWorkspacePath('main');

  if (fs.existsSync(mainWorkspace)) {
    return res.json({ success: true, path: mainWorkspace });
  }

  res.json({ success: false, message: 'Could not automatically detect workspace' });
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
    await execPromise('openclaw gateway restart');

    res.json({ success: true, message: 'Gateway connections reset and service restarted' });
  } catch (error: any) {
    console.error('Failed to restart gateway:', error);
    res.status(500).json({ success: false, error: '执行重启命令失败: ' + error.message });
  }
});

app.get('/api/models', (_req, res) => {
  const models = agentProvisioner.readAvailableModels();
  res.json({ success: true, models });
});

app.post('/api/models/manage', async (req, res) => {
  try {
    const { endpoint, modelName, alias } = req.body;
    if (!endpoint || !modelName) {
      return res.status(400).json({ success: false, error: 'endpoint and modelName required' });
    }
    const success = await agentProvisioner.addModelConfig(endpoint, modelName, alias);
    if (success) {
      // Restart the gateway to apply
      execPromise('openclaw gateway restart').catch(console.error);
      return res.json({ success: true });
    }
    return res.status(400).json({ success: false, error: 'Model may already exist or config invalid' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/models/manage', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    
    const success = await agentProvisioner.deleteModelConfig(id);
    if (success) {
      // Restart the gateway to apply
      execPromise('openclaw gateway restart').catch(console.error);
      return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Model not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/models/manage/default', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const success = await agentProvisioner.setDefaultModel(id);
    if (success) {
      // Restart the gateway to apply
      execPromise('openclaw gateway restart').catch(console.error);
      return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Model not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/models/manage', async (req, res) => {
  try {
    const { id, alias } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const success = await agentProvisioner.updateModelConfig(id, alias);
    if (success) {
      return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Model not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
      try { await execPromise('openclaw gateway restart'); } catch (e) {
        console.error('Failed to restart gateway:', e);
      }
    }
  }
  
  db.saveCharacter(char);

  if (configChanged) {
      console.log('OpenClaw config changed for new agent, restarting gateway...');
      try {
          await execPromise('openclaw gateway restart');
      } catch (e) {
          console.error('Failed to restart gateway automatically:', e);
      }
  }

  res.json({ success: true, character: char });
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
        console.log(`Agent "${character.agentId}" fully removed, restarting gateway...`);
        try {
          await execPromise('openclaw gateway restart');
        } catch (e) {
          console.error('Failed to restart gateway automatically:', e);
        }
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
  const { id, name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model } = req.body;
  const prompt = soulContent;
  
  if (id && sessionManager.getSession(id)) {
    return res.status(400).json({ success: false, error: 'Agent ID already exists' });
  }

  // Provide basic default for first session if it doesn't exist
  const newSession = sessionManager.createSession({ id, name, prompt });
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
    model 
  });
  
  // Update session record with the auto-generated agentId
  sessionManager.updateSession(newSession.id, { agentId });
  const finalSession = sessionManager.getSession(newSession.id);

  res.json({ success: true, session: finalSession });
});

app.put('/api/sessions/:id', async (req, res) => {
  const { name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model } = req.body;
  const prompt = soulContent;
  const session = sessionManager.getSession(req.params.id);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const updated = sessionManager.updateSession(req.params.id, { name, prompt });
  
  if (session.agentId) {
    await agentProvisioner.updateSoul(session.agentId, prompt || '');
    if (userContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'USER.md', userContent);
    if (agentsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'AGENTS.md', agentsContent);
    if (toolsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'TOOLS.md', toolsContent);
    if (heartbeatContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'HEARTBEAT.md', heartbeatContent);
    if (identityContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'IDENTITY.md', identityContent);
    
    // Model update might require gateway restart
    const modelChanged = await agentProvisioner.updateModel(session.agentId, model);
    if (modelChanged) {
      try { await execPromise('openclaw gateway restart'); } catch(e) {}
    }
  }

  res.json({ success: true, session: updated });
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
        try { await execPromise('openclaw gateway restart'); } catch(e) {}
      }
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Endpoint to fetch all configuring MD files for a given session's agent
app.get('/api/sessions/:id/configs', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  const agentId = session.agentId;
  res.json({
    success: true,
    configs: {
      soulContent: agentProvisioner.readSoul(agentId) || '',
      userContent: agentProvisioner.readAgentFile(agentId, 'USER.md', ''),
      agentsContent: agentProvisioner.readAgentFile(agentId, 'AGENTS.md', ''),
      toolsContent: agentProvisioner.readAgentFile(agentId, 'TOOLS.md', ''),
      heartbeatContent: agentProvisioner.readAgentFile(agentId, 'HEARTBEAT.md', ''),
      identityContent: agentProvisioner.readAgentFile(agentId, 'IDENTITY.md', ''),
      model: agentProvisioner.readAgentModel(agentId)
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
  const rows = db.getMessages(req.params.sessionId, 200).reverse();
  res.json({ success: true, messages: rows });
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

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  try {
    const sessionInfo = sessionManager.getSession(sessionId);
    let finalMessage = String(message);

    if (sessionInfo && sessionInfo.prompt) {
      const history = db.getMessages(sessionId, 1);
      if (history.length === 0) {
        finalMessage = `[System Instructions: ${sessionInfo.prompt}]\n\nUser: ${finalMessage}`;
      }
    }

    db.saveMessage({ session_key: sessionId, role: 'user', content: String(message) });
    const client = await getConnection(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const outgoingMessage = rewriteOutgoingMessage(finalMessage, agentId);

    // Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let lastText = '';
    let streamEnded = false;

    const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
      if (streamEnded) return;
      lastText = data.text;
      const rewritten = rewriteOpenClawMediaPaths(data.text);
      res.write(`data: ${JSON.stringify({ type: 'delta', text: rewritten })}\n\n`);
    };

    const onFinal = (data: { sessionKey: string; runId: string; text: string }) => {
      if (streamEnded) return;
      streamEnded = true;
      const finalText = data.text || lastText;
      const rewritten = rewriteOpenClawMediaPaths(finalText);

      // Save final response to DB
      db.saveMessage({ session_key: sessionId, role: 'assistant', content: rewritten });

      res.write(`data: ${JSON.stringify({ type: 'final', text: rewritten })}\n\n`);
      res.end();

      // Cleanup listeners
      client.off('chat.delta', onDelta);
      client.off('chat.final', onFinal);
    };

    // Listen for streaming events
    client.on('chat.delta', onDelta);
    client.on('chat.final', onFinal);

    // Send the message (non-blocking)
    const { runId } = await client.sendChatMessageStreaming({
      sessionKey: sessionId,
      message: outgoingMessage,
      agentId: agentId
    });

    // Safety timeout: if no final event after 120s, end the stream
    const safetyTimeout = setTimeout(() => {
      if (!streamEnded) {
        streamEnded = true;
        const rewritten = rewriteOpenClawMediaPaths(lastText || 'Response timed out.');
        db.saveMessage({ session_key: sessionId, role: 'assistant', content: rewritten });
        res.write(`data: ${JSON.stringify({ type: 'final', text: rewritten })}\n\n`);
        res.end();
        client.off('chat.delta', onDelta);
        client.off('chat.final', onFinal);
      }
    }, 120000);

    // Clean up on client disconnect
    req.on('close', () => {
      streamEnded = true;
      clearTimeout(safetyTimeout);
      client.off('chat.delta', onDelta);
      client.off('chat.final', onFinal);
    });

  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
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
    const response = rewriteOpenClawMediaPaths(rawResponse);
    // Note: We intentionally DO NOT save to DB here
    res.json({ success: true, response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// file upload (doc/image/video/audio), supports multiple files
app.post('/api/files/upload', upload.array('files', 20), (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

  const sessionId = (req.body?.sessionId as string) || '';
  const saved = files.map((f) => {
    db.saveFile({
      sessionKey: sessionId,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      storedPath: f.path,
    });

    return {
      name: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      url: `/uploads/${path.basename(f.path)}`,
    };
  });

  res.json({
    success: true,
    files: saved,
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
    // Set proper Content-Disposition with UTF-8 filename for correct downloads
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
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

app.get('/api/files/preview', async (req, res) => {
  try {
    if (!hasLibreOffice) {
      return res.status(501).json({ error: 'LibreOffice not available', fallback: true });
    }

    let absolutePath = '';
    const b64Path = req.query.path as string;
    const filenameParam = req.query.filename as string;

    if (b64Path) {
      absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');
      if (!path.isAbsolute(absolutePath)) {
        return res.status(403).send('Only absolute paths are allowed');
      }
    } else if (filenameParam) {
      // Resolve uploaded file path
      const decodedFilename = decodeURIComponent(filenameParam);
      const fileInfo = db.getFileByStoredName(decodedFilename);
      if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
        absolutePath = fileInfo.stored_path;
      } else {
        const globalPath = path.join(uploadDir, decodedFilename);
        if (fs.existsSync(globalPath)) {
          absolutePath = globalPath;
        }
      }
    }

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return res.status(404).send('File not found');
    }

    // Create a hash-based cache key
    const crypto = require('crypto');
    const stat = fs.statSync(absolutePath);
    const cacheKey = crypto.createHash('md5').update(`${absolutePath}:${stat.mtimeMs}`).digest('hex');
    const cachedPdf = path.join(previewCacheDir, `${cacheKey}.pdf`);

    // Serve from cache if available
    if (fs.existsSync(cachedPdf)) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.sendFile(cachedPdf);
    }

    // Convert using LibreOffice
    const tmpDir = path.join(previewCacheDir, cacheKey);
    fs.mkdirSync(tmpDir, { recursive: true });

    await execPromise(
      `libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${absolutePath}"`,
      { timeout: 30000 }
    );

    // Find the output PDF
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.pdf'));
    if (files.length === 0) {
      throw new Error('LibreOffice conversion produced no PDF output');
    }

    const outputPdf = path.join(tmpDir, files[0]);
    // Move to cache location
    fs.renameSync(outputPdf, cachedPdf);
    // Clean up tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(cachedPdf);
  } catch (error: any) {
    console.error(`[Preview Error] ${error.message}`);
    res.status(500).json({ error: 'Preview conversion failed', message: error.message });
  }
});

// Serve static files from frontend
app.use(express.static(path.join(__dirname, '../../frontend/dist')));

// Fallback for SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

// Error handling
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Express error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// Start server
const PORT = Number(process.env.PORT) || 3100;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ClawUI backend listening on http://0.0.0.0:${PORT}`);
});
