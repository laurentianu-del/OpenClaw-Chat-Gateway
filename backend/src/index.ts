import express from 'express';
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
    let finalUploadDir = uploadDir;

    if (config.openclawWorkspace) {
      // Expand ~ if present
      let workspacePath = config.openclawWorkspace;
      if (workspacePath.startsWith('~')) {
        workspacePath = path.join(process.env.HOME || '', workspacePath.slice(1));
      }
      
      const sharedUploadDir = path.join(workspacePath, 'uploads');
      try {
        fs.mkdirSync(sharedUploadDir, { recursive: true });
        finalUploadDir = sharedUploadDir;
      } catch (err) {
        console.error(`[Upload] Failed to use shared workspace: ${err instanceof Error ? err.message : String(err)}`);
      }
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
function rewriteOutgoingMessage(message: string): string {
  const config = configManager.getConfig();
  if (!config.openclawWorkspace) return message;

  let workspacePath = config.openclawWorkspace;
  if (workspacePath.startsWith('~')) {
    workspacePath = path.join(process.env.HOME || '', workspacePath.slice(1));
  }
  const absoluteUploadsDir = path.join(workspacePath, 'uploads');

  // Regex to find markdown links like [name](/uploads/filename) or ![name](/uploads/filename)
  // or naked /uploads/filename if not in markdown
  return message.replace(/(\(?\/uploads\/)([^\s)]+)(\)?)/g, (match, prefix, filename, suffix) => {
    const absolutePath = path.join(absoluteUploadsDir, filename);
    // If it was in parens (markdown), we might want to keep the parens or replace the whole thing
    // Actually, OpenClaw expects file paths, so replacing (/uploads/...) with (absolute_path) is good
    // But sometimes it might just be the raw string.
    return `${prefix.startsWith('(') ? '(' : ''}${absolutePath}${suffix.endsWith(')') ? ')' : ''}`;
  });
}

const connections = new Map<string, OpenClawClient>();

// Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
function rewriteOpenClawMediaPaths(text: string): string {
  // Match absolute paths like /home/user/.openclaw/media/browser/xxx.jpg
  const homeDir = process.env.HOME || '';
  const mediaPrefix = path.join(homeDir, '.openclaw', 'media');
  // Escape for regex
  const escaped = mediaPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped + '(/[^\\s)\\]"]+)', 'g');
  return text.replace(regex, '/openclaw-media$1');
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
  const homeDir = process.env.HOME || '';
  const possiblePaths = [
    path.join(homeDir, '.openclaw', 'workspace'),
    '/root/.openclaw/workspace',
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return res.json({ success: true, path: p });
    }
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

app.get('/api/sessions', (_req, res) => {
  const sessions = sessionManager.getAllSessions();
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  const { name, description, prompt } = req.body;
  const newSession = sessionManager.createSession({ name, description, prompt });
  res.json({ success: true, session: newSession });
});

app.put('/api/sessions/:id', (req, res) => {
  const { name, description, prompt } = req.body;
  const updated = sessionManager.updateSession(req.params.id, { name, description, prompt });
  if (updated) {
    res.json({ success: true, session: updated });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const success = sessionManager.deleteSession(req.params.id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found or default session' });
  }
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

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  try {
    const sessionInfo = sessionManager.getSession(sessionId);
    let finalMessage = String(message);

    // If session has a system prompt, check if this is the first message
    if (sessionInfo && sessionInfo.prompt) {
      const history = db.getMessages(sessionId, 1);
      if (history.length === 0) {
        // Prepend the prompt if it's the very first message
        finalMessage = `[System Instructions: ${sessionInfo.prompt}]\n\nUser: ${finalMessage}`;
      }
    }

    db.saveMessage({ session_key: sessionId, role: 'user', content: String(message) });
    const client = await getConnection(sessionId);
    
    // Rewrite outgoing message to expand relative upload paths to absolute ones for OpenClaw
    const outgoingMessage = rewriteOutgoingMessage(finalMessage);
    
    const rawResponse = await client.sendChatMessage({ sessionKey: sessionId, message: outgoingMessage });
    // Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
    const response = rewriteOpenClawMediaPaths(rawResponse);
    db.saveMessage({ session_key: sessionId, role: 'assistant', content: String(response) });
    res.json({ success: true, response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

app.use('/uploads', express.static(uploadDir));

// Serve OpenClaw media files (screenshots, inbound, etc.)
app.use('/openclaw-media', express.static(openclawMediaDir));

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
