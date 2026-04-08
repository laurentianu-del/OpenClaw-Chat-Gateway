import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_USER_MD = `# User Profile

- 语言偏好：中文
- 称呼方式：随意
`;

const DEFAULT_AGENTS_MD = `# Agent Instructions

- 遵循 SOUL.md 中定义的人格设定
- 使用 memory/ 目录记录重要信息
- 保持角色一致性
`;

export interface ProvisionOptions {
  agentId: string;
  workspaceDir?: string;
  soulContent?: string;
  userContent?: string;
  agentsContent?: string;
  toolsContent?: string;
  heartbeatContent?: string;
  identityContent?: string;
  model?: string;  // e.g. "openai/gpt-5.2" or "ark/glm-4.7"
  fallbackMode?: AgentFallbackMode;
  fallbacks?: string[];
}

export type AgentFallbackMode = 'inherit' | 'custom' | 'disabled';

export interface AgentModelConfigSnapshot {
  model: string | null;
  modelOverride: string | null;
  fallbackMode: AgentFallbackMode;
  fallbacks: string[];
  resolvedModel: string | null;
}

export interface GlobalModelConfigSnapshot {
  primary: string | null;
  fallbacks: string[];
}

export class AgentProvisioner {
  private openclawDir: string;

  constructor() {
    this.openclawDir = path.join(os.homedir(), '.openclaw');
  }

  private readConfigFile(): any | null {
    const configPath = path.join(this.openclawDir, 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      console.error('Failed to read openclaw.json:', error);
      return null;
    }
  }

  private writeConfigFile(config: any): void {
    const configPath = path.join(this.openclawDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  private normalizeModelId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeFallbackIds(value: unknown): string[] {
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

  private getConfiguredModelIds(config: any): Set<string> {
    return new Set(
      Object.keys(config?.agents?.defaults?.models || {}).filter((id) => typeof id === 'string' && id.trim())
    );
  }

  private validateModelIds(config: any, ids: string[]): void {
    const configuredIds = this.getConfiguredModelIds(config);
    if (configuredIds.size === 0) return;

    const missing = ids.filter((id) => !configuredIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown model id: ${missing.join(', ')}`);
    }
  }

  private readStoredModelValue(raw: any): { primary: string | null; hasFallbacks: boolean; fallbacks: string[] } {
    if (typeof raw === 'string') {
      return {
        primary: this.normalizeModelId(raw),
        hasFallbacks: false,
        fallbacks: [],
      };
    }

    if (!raw || typeof raw !== 'object') {
      return {
        primary: null,
        hasFallbacks: false,
        fallbacks: [],
      };
    }

    return {
      primary: this.normalizeModelId(raw.primary),
      hasFallbacks: Object.prototype.hasOwnProperty.call(raw, 'fallbacks'),
      fallbacks: this.normalizeFallbackIds(raw.fallbacks),
    };
  }

  private resolveFallbackMode(hasFallbacks: boolean, fallbacks: string[]): AgentFallbackMode {
    if (!hasFallbacks) return 'inherit';
    return fallbacks.length > 0 ? 'custom' : 'disabled';
  }

  private buildStoredModelValue(
    primary: string | null,
    fallbackMode: AgentFallbackMode,
    fallbacks: string[]
  ): any {
    const normalizedPrimary = this.normalizeModelId(primary);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);

    if (fallbackMode === 'inherit') {
      return normalizedPrimary || undefined;
    }

    const next: Record<string, any> = {
      fallbacks: fallbackMode === 'disabled' ? [] : normalizedFallbacks,
    };

    if (normalizedPrimary) {
      next.primary = normalizedPrimary;
    }

    return next;
  }

  private ensureAgentEntry(config: any, agentId: string, workspaceDir: string) {
    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    let entry = config.agents.list.find((item: any) => item.id === agentId);
    if (!entry) {
      entry = { id: agentId, workspace: workspaceDir };
      config.agents.list.push(entry);
      return { entry, created: true, workspaceChanged: false };
    }

    let workspaceChanged = false;
    if (entry.workspace !== workspaceDir) {
      entry.workspace = workspaceDir;
      workspaceChanged = true;
    }

    return { entry, created: false, workspaceChanged };
  }

  private assignModelValue(entry: any, nextValue: any): boolean {
    const prevSerialized = Object.prototype.hasOwnProperty.call(entry, 'model')
      ? JSON.stringify(entry.model)
      : '__missing__';

    if (nextValue === undefined) {
      if (!Object.prototype.hasOwnProperty.call(entry, 'model')) {
        return false;
      }
      delete entry.model;
      return true;
    }

    const nextSerialized = JSON.stringify(nextValue);
    if (prevSerialized === nextSerialized) {
      return false;
    }

    entry.model = nextValue;
    return true;
  }

  private pruneModelValue(raw: any, deletedIds: Set<string>): any {
    const stored = this.readStoredModelValue(raw);
    const nextPrimary = stored.primary && deletedIds.has(stored.primary) ? null : stored.primary;
    const nextFallbacks = stored.fallbacks.filter((id) => !deletedIds.has(id));

    if (!stored.hasFallbacks) {
      return nextPrimary || undefined;
    }

    return this.buildStoredModelValue(
      nextPrimary,
      nextFallbacks.length > 0 ? 'custom' : 'disabled',
      nextFallbacks
    );
  }

  /**
   * Slugify a name to be used as a directory and agent ID
   */
  slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '_')
      .replace(/^-+|-+$/g, '');
    
    // Fallback if slug is empty (e.g. only Chinese characters)
    return slug || `agent_${Date.now().toString(36)}`;
  }

  /**
   * Get the workspace path for a given agentId.
   * Rule: agent "abc" uses "workspace-abc". No special cases.
   */
  getWorkspacePath(agentId: string): string {
    return path.join(this.openclawDir, `workspace-${agentId}`);
  }

  /**
   * Ensure the 'main' agent has its workspace path registered in openclaw.json.
   * Called at application startup so that the OpenClaw engine also picks up
   * the correct workspace-main/ path instead of the default workspace/.
   */
  ensureMainAgent(): boolean {
    const configPath = path.join(this.openclawDir, 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    const workspaceDir = this.getWorkspacePath('main');
    const existing = config.agents.list.find((a: any) => a.id === 'main');

    if (existing) {
      if (existing.workspace === workspaceDir) return false; // already correct
      existing.workspace = workspaceDir;
    } else {
      config.agents.list.push({ id: 'main', workspace: workspaceDir });
    }

    // Ensure the workspace directory exists
    fs.mkdirSync(workspaceDir, { recursive: true });

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[AgentProvisioner] Registered main agent workspace: ${workspaceDir}`);
    return true;
  }

  /**
   * Provision a fully isolated agent environment in OpenClaw.
   * 
   * Creates:
   * - Independent workspace with SOUL.md, USER.md, AGENTS.md, memory/
   * - Agent entry in openclaw.json agents.list[]
   * - Copies auth-profiles.json from main agent for credential inheritance
   */
  async provision(opts: ProvisionOptions): Promise<boolean> {
    try {
      if (!fs.existsSync(this.openclawDir)) {
        console.error('OpenClaw directory not found at', this.openclawDir);
        return false;
      }


      const workspaceDir = opts.workspaceDir || this.getWorkspacePath(opts.agentId);
      const agentDir = path.join(this.openclawDir, 'agents', opts.agentId, 'agent');
      const memoryDir = path.join(workspaceDir, 'memory');
      
      // 1. Create workspace directory structure
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      // 2. Write workspace files
      const writeFileSafe = (filename: string, content: string | undefined, defaultContent?: string) => {
        const filePath = path.join(workspaceDir, filename);
        if (content !== undefined) {
          fs.writeFileSync(filePath, content);
        } else if (defaultContent !== undefined && !fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, defaultContent);
        }
      };

      writeFileSafe('SOUL.md', opts.soulContent, '# Agent\nDefault identity.');
      writeFileSafe('USER.md', opts.userContent, '# User Profile\n\n- 语言偏好：中文\n- 称呼方式：随意\n');
      writeFileSafe('AGENTS.md', opts.agentsContent, '# Agent Instructions\n\n- 遵循 SOUL.md 中定义的人格设定\n- 使用 memory/ 目录记录重要信息\n- 保持角色一致性\n');
      writeFileSafe('TOOLS.md', opts.toolsContent);
      writeFileSafe('HEARTBEAT.md', opts.heartbeatContent);
      writeFileSafe('IDENTITY.md', opts.identityContent);

      // 3. Copy auth-profiles.json from main agent for credential inheritance
      const mainAuthPath = path.join(this.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      const agentAuthPath = path.join(agentDir, 'auth-profiles.json');
      if (fs.existsSync(mainAuthPath) && !fs.existsSync(agentAuthPath)) {
        fs.copyFileSync(mainAuthPath, agentAuthPath);
      }

      // 4. Update openclaw.json agents.list[]
      const configChanged = this.updateConfigList(
        opts.agentId,
        workspaceDir,
        opts.model,
        opts.fallbackMode,
        opts.fallbacks
      );

      console.log(`[AgentProvisioner] Provisioned agent "${opts.agentId}" at ${workspaceDir}`);
      return configChanged;
    } catch (error) {
      console.error('Failed to provision agent:', error);
      return false;
    }
  }

  /**
   * Remove an agent from openclaw.json agents.list[]
   * Also removes the workspace directory and agent state directory.
   */
  async deprovision(agentId: string): Promise<boolean> {
    try {
      if (agentId === 'main') return false;

      const configPath = path.join(this.openclawDir, 'openclaw.json');
      if (!fs.existsSync(configPath)) return false;

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      let configChanged = false;
      if (config.agents?.list && Array.isArray(config.agents.list)) {
        const before = config.agents.list.length;
        config.agents.list = config.agents.list.filter(
          (a: any) => a.id !== agentId
        );
        if (config.agents.list.length < before) {
          configChanged = true;
          // If list is empty, remove it entirely to keep config clean
          if (config.agents.list.length === 0) {
            delete config.agents.list;
          }
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      }

      // Clean up workspace directory
      const workspaceDir = this.getWorkspacePath(agentId);
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        console.log(`[AgentProvisioner] Removed workspace ${workspaceDir}`);
      }

      // Clean up agent state directory
      const agentStateDir = path.join(this.openclawDir, 'agents', agentId);
      if (fs.existsSync(agentStateDir)) {
        fs.rmSync(agentStateDir, { recursive: true, force: true });
        console.log(`[AgentProvisioner] Removed agent state ${agentStateDir}`);
      }

      const memoryDbPath = path.join(this.openclawDir, 'memory', `${agentId}.sqlite`);
      if (fs.existsSync(memoryDbPath)) {
        fs.rmSync(memoryDbPath, { force: true });
        console.log(`[AgentProvisioner] Removed agent memory ${memoryDbPath}`);
      }

      console.log(`[AgentProvisioner] Deprovisioned agent "${agentId}"`);
      return configChanged;
    } catch (error) {
      console.error('Failed to deprovision agent:', error);
      return false;
    }
  }

  /**
   * Remove an agent entry from openclaw.json without touching its workspace.
   * Useful when the workspace is managed outside the default workspace-{agentId} rule.
   */
  removeConfigEntry(agentId: string): boolean {
    if (agentId === 'main') return false;

    const configPath = path.join(this.openclawDir, 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.agents?.list || !Array.isArray(config.agents.list)) {
      return false;
    }

    const before = config.agents.list.length;
    config.agents.list = config.agents.list.filter((a: any) => a.id !== agentId);
    if (config.agents.list.length === before) {
      return false;
    }

    if (config.agents.list.length === 0) {
      delete config.agents.list;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  }

  /**
   * Update SOUL.md for an existing agent.
   */
  async updateSoul(agentId: string, soulContent: string): Promise<void> {
    const workspaceDir = this.getWorkspacePath(agentId);
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(soulPath, soulContent || '# Agent\nDefault identity.');
  }

  /**
   * Read SOUL.md content for a given agent.
   */
  readSoul(agentId: string): string | null {
    const workspaceDir = this.getWorkspacePath(agentId);
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      return fs.readFileSync(soulPath, 'utf-8');
    }
    return null;
  }

  /**
   * Read available models from openclaw.json agents.defaults.models
   * Returns an array of { id: "provider/modelId", alias?: string, primary: boolean }
   */
  readAvailableModels(): { id: string; alias?: string; primary: boolean; input: string[] }[] {
    try {
      const config = this.readConfigFile();
      if (!config) return [];
      const modelsMap = config?.agents?.defaults?.models;
      const primaryModel = this.readGlobalModelConfig().primary;
      if (!modelsMap || typeof modelsMap !== 'object') return [];

      return Object.entries(modelsMap).map(([id, meta]: [string, any]) => {
        // First look for input capabilities stored directly on this model entry
        let input: string[] = Array.isArray(meta?.input) ? meta.input : [];

        // Fallback: check the provider's model list definition in models.providers
        if (!input.length) {
          const slashIdx = id.indexOf('/');
          if (slashIdx !== -1) {
            const endpointId = id.slice(0, slashIdx);
            const modelName = id.slice(slashIdx + 1);
            const providerModels = config?.models?.providers?.[endpointId]?.models;
            if (Array.isArray(providerModels)) {
              const pModel = providerModels.find((m: any) => m.id === modelName);
              if (Array.isArray(pModel?.input)) {
                for (const item of pModel.input) {
                  if (!input.includes(item)) input.push(item);
                }
              }
            }
          }
        }

        // Overlay from clawui-models.json 
        try {
          const uiModelsPath = path.join(this.openclawDir, 'clawui-models.json');
          if (fs.existsSync(uiModelsPath)) {
            const uiModels = JSON.parse(fs.readFileSync(uiModelsPath, 'utf-8'));
            if (uiModels[id] && Array.isArray(uiModels[id].input)) {
              input = uiModels[id].input;
            }
          }
        } catch(e) {}

        return {
          id,
          alias: meta?.alias || undefined,
          primary: id === primaryModel,
          input,
        };
      });
    } catch (err) {
      console.error('Failed to read models from openclaw.json:', err);
      return [];
    }
  }

  /**
   * Add a new model to openclaw.json
   */
  async addModelConfig(endpoint: string, modelName: string, alias?: string, input?: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};

    const modelId = `${endpoint}/${modelName}`;
    if (config.agents.defaults.models[modelId]) {
      // Model already exists
      return false;
    }

    const entry: Record<string, any> = {};
    if (alias && alias.trim()) entry.alias = alias.trim();
    config.agents.defaults.models[modelId] = entry;

    // Synchronize capabilities to clawui-models.json to avoid strict schema validation
    if (input && input.length > 0) {
      try {
        const uiModelsPath = path.join(this.openclawDir, 'clawui-models.json');
        let uiModels: any = {};
        if (fs.existsSync(uiModelsPath)) uiModels = JSON.parse(fs.readFileSync(uiModelsPath, 'utf-8'));
        if (!uiModels[modelId]) uiModels[modelId] = {};
        uiModels[modelId].input = input;
        fs.writeFileSync(uiModelsPath, JSON.stringify(uiModels, null, 2));
      } catch(e) { console.error('Failed to sync UI models:', e); }
    }

    // Synchronize to models.providers[endpoint].models so OpenClaw engine can route it
    if (config.models?.providers?.[endpoint]) {
      const provider = config.models.providers[endpoint];
      if (!provider.models) provider.models = [];
      
      const existingModel = provider.models.find((m: any) => m.id === modelName);
      if (existingModel) {
        existingModel.name = existingModel.name || `${modelName} (Custom Provider)`;
        if (input && input.length > 0) existingModel.input = input;
      } else {
        provider.models.push({
          id: modelName,
          name: `${modelName} (Custom Provider)`,
          api: provider.api || 'openai-completions',
          reasoning: false,
          input: input && input.some(i => i === 'text' || i === 'image') ? input.filter(i => i === 'text' || i === 'image') : ['text']
        });
      }
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Delete a model from openclaw.json and fallback agents using it to default
   */
  async deleteModelConfig(modelId: string): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents?.defaults?.models?.[modelId]) {
      return false; // Model doesn't exist
    }

    // 1. Remove the model definition
    delete config.agents.defaults.models[modelId];

    // 2. Handle primary model fallback
    const globalModelConfig = this.readStoredModelValue(config.agents?.defaults?.model);
    if (globalModelConfig.primary === modelId) {
      // Choose the first available model as the new primary, or delete it
      const remainingModels = Object.keys(config.agents.defaults.models);
      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }
      if (remainingModels.length > 0) {
        config.agents.defaults.model.primary = remainingModels[0];
      } else {
        delete config.agents.defaults.model.primary;
      }
    }

    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }
    if (globalModelConfig.primary && globalModelConfig.primary !== modelId) {
      config.agents.defaults.model.primary = globalModelConfig.primary;
    }
    config.agents.defaults.model.fallbacks = globalModelConfig.fallbacks.filter((id) => id !== modelId);

    // 3. Fallback agents that were using this model (deleting their 'model' falls back to default)
    if (Array.isArray(config.agents.list)) {
      config.agents.list.forEach((agent: any) => {
        const pruned = this.pruneModelValue(agent.model, new Set([modelId]));
        if (pruned === undefined) delete agent.model;
        else agent.model = pruned;
      });
    }

    // 4. Remove from models.providers if it exists there
    const slashIdx = modelId.indexOf('/');
    if (slashIdx !== -1) {
      const endpoint = modelId.slice(0, slashIdx);
      const modelName = modelId.slice(slashIdx + 1);
      if (config.models?.providers?.[endpoint]?.models) {
        config.models.providers[endpoint].models = config.models.providers[endpoint].models.filter(
          (m: any) => m.id !== modelName
        );
      }
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Set a model as the default (primary) model in openclaw.json
   */
  async setDefaultModel(modelId: string): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    const defaultsModelEntry = this.readStoredModelValue(config.agents.defaults.model);

    // Validate if the model actually exists
    if (!config.agents.defaults.models?.[modelId]) {
      return false;
    }

    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }

    config.agents.defaults.model.primary = modelId;

    // Explicitly sync this to the 'main' agent in agents.list so OpenClaw Gateway hot-swaps it
    if (config.agents.list && Array.isArray(config.agents.list)) {
      const mainAgent = config.agents.list.find((a: any) => a.id === 'main');
      if (mainAgent) {
        const mainModel = this.readStoredModelValue(mainAgent.model);
        mainAgent.model = mainModel.hasFallbacks
          ? this.buildStoredModelValue(modelId, this.resolveFallbackMode(mainModel.hasFallbacks, mainModel.fallbacks), mainModel.fallbacks)
          : modelId;
      }
    }

    if (defaultsModelEntry.fallbacks.length > 0) {
      config.agents.defaults.model.fallbacks = defaultsModelEntry.fallbacks;
    } else if (Object.prototype.hasOwnProperty.call(config.agents.defaults.model, 'fallbacks')) {
      config.agents.defaults.model.fallbacks = defaultsModelEntry.fallbacks;
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Update a model's alias in openclaw.json
   */
  async updateModelConfig(modelId: string, alias?: string, input?: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents?.defaults?.models?.[modelId]) {
      return false; // Model doesn't exist
    }

    const current = config.agents.defaults.models[modelId] || {};
    const updated: Record<string, any> = { ...current };

    // Update alias
    if (alias !== undefined) {
      if (alias.trim()) updated.alias = alias.trim();
      else delete updated.alias;
    }

    // Update input capabilities (in clawui-models.json instead of openclaw.json)
    if (input !== undefined) {
      try {
        const uiModelsPath = path.join(this.openclawDir, 'clawui-models.json');
        let uiModels: any = {};
        if (fs.existsSync(uiModelsPath)) uiModels = JSON.parse(fs.readFileSync(uiModelsPath, 'utf-8'));
        if (!uiModels[modelId]) uiModels[modelId] = {};
        
        if (input.length > 0) {
          uiModels[modelId].input = input;
        } else {
          delete uiModels[modelId].input;
        }
        fs.writeFileSync(uiModelsPath, JSON.stringify(uiModels, null, 2));
      } catch(e) { console.error('Failed to sync updated UI models:', e); }
    }

    config.agents.defaults.models[modelId] = updated;
    this.writeConfigFile(config);
    return true;
  }

  /**
   * Delete all models under a given endpoint in openclaw.json, and the endpoint itself
   */
  async deleteEndpointConfig(endpoint: string): Promise<number> {
    const config = this.readConfigFile();
    if (!config) return 0;
    let deletedCount = 0;

    // 1. Delete associated models
    if (config.agents?.defaults?.models) {
      const prefix = `${endpoint}/`;
      const toDelete = Object.keys(config.agents.defaults.models).filter(id => id.startsWith(prefix));
      
      for (const modelId of toDelete) {
        delete config.agents.defaults.models[modelId];
        deletedCount++;
      }

      // Handle primary model fallback
      const deletedSet = new Set(toDelete);
      const defaultModelConfig = this.readStoredModelValue(config.agents?.defaults?.model);
      const primary = defaultModelConfig.primary;
      if (primary && toDelete.includes(primary)) {
        const remaining = Object.keys(config.agents.defaults.models);
        if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
          config.agents.defaults.model = {};
        }
        if (remaining.length > 0) {
          config.agents.defaults.model.primary = remaining[0];
        } else {
          delete config.agents.defaults.model.primary;
        }
      }

      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }
      if (primary && !deletedSet.has(primary)) {
        config.agents.defaults.model.primary = primary;
      }
      config.agents.defaults.model.fallbacks = defaultModelConfig.fallbacks
        .filter((id: string) => !deletedSet.has(id));

      // Fallback agents using any deleted model
      if (Array.isArray(config.agents.list)) {
        config.agents.list.forEach((agent: any) => {
          const pruned = this.pruneModelValue(agent.model, deletedSet);
          if (pruned === undefined) delete agent.model;
          else agent.model = pruned;
        });
      }
    }

    // 2. Delete the endpoint provider definition itself
    if (config.models?.providers?.[endpoint]) {
      delete config.models.providers[endpoint];
      deletedCount++; // Ensure count > 0 to signal success
    }

    if (deletedCount > 0) {
      this.writeConfigFile(config);
    }
    
    return deletedCount;
  }

  /**
   * Get the list of all defined endpoints in openclaw.json
   */
  getEndpoints(): any[] {
    try {
      const config = this.readConfigFile();
      if (!config) return [];
      const providers = config?.models?.providers;
      if (!providers || typeof providers !== 'object') return [];

      return Object.entries(providers).map(([id, meta]: [string, any]) => ({
        id,
        baseUrl: meta?.baseUrl || '',
        apiKey: meta?.apiKey || '',
        api: meta?.api || 'openai-completions',
      }));
    } catch (err) {
      console.error('Failed to read endpoints from openclaw.json:', err);
      return [];
    }
  }

  /**
   * Add or update an endpoint provider in openclaw.json
   */
  async saveEndpoint(id: string, endpointConfig: { baseUrl: string, apiKey: string, api: string }): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    const existing = config.models.providers[id];
    config.models.providers[id] = {
      ...existing, // preserve existing models array or other metadata
      baseUrl: endpointConfig.baseUrl.trim(),
      apiKey: endpointConfig.apiKey.trim(),
      api: endpointConfig.api,
      models: existing?.models || []
    };

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Update the model for an existing agent in openclaw.json
   * For 'main' agent: updates agents.defaults.model.primary
   * For other agents: updates agents.list[].model
   */
  async updateModel(
    agentId: string,
    model?: string | null,
    fallbackConfig?: { mode?: AgentFallbackMode; fallbacks?: string[] }
  ): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedModel = this.normalizeModelId(model);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbackConfig?.fallbacks);
    const fallbackMode = fallbackConfig?.mode
      ?? (fallbackConfig ? (normalizedFallbacks.length > 0 ? 'custom' : 'disabled') : 'inherit');

    const idsToValidate = [
      ...(normalizedModel ? [normalizedModel] : []),
      ...normalizedFallbacks,
    ];
    this.validateModelIds(config, idsToValidate);

    if (agentId === 'main') {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};

      const globalConfig = this.readStoredModelValue(config.agents.defaults.model);
      const nextPrimary = normalizedModel || globalConfig.primary;
      if (!nextPrimary) {
        return false;
      }

      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }

      const prevDefaultSerialized = JSON.stringify(config.agents.defaults.model);
      config.agents.defaults.model.primary = nextPrimary;
      if (globalConfig.hasFallbacks || Object.prototype.hasOwnProperty.call(config.agents.defaults.model, 'fallbacks')) {
        config.agents.defaults.model.fallbacks = globalConfig.fallbacks;
      }

      const { entry, workspaceChanged } = this.ensureAgentEntry(config, 'main', this.getWorkspacePath('main'));
      const mainStoredModel = this.buildStoredModelValue(nextPrimary, fallbackMode, normalizedFallbacks);
      const modelChanged = this.assignModelValue(entry, mainStoredModel);
      const defaultChanged = JSON.stringify(config.agents.defaults.model) !== prevDefaultSerialized;

      if (!defaultChanged && !modelChanged && !workspaceChanged) {
        return false;
      }

      this.writeConfigFile(config);
      return true;
    }

    const { entry, created, workspaceChanged } = this.ensureAgentEntry(config, agentId, this.getWorkspacePath(agentId));
    const nextStoredModel = this.buildStoredModelValue(normalizedModel, fallbackMode, normalizedFallbacks);
    const changed = this.assignModelValue(entry, nextStoredModel);

    if (!changed && !created && !workspaceChanged) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Read the actual model configured for an agent from openclaw.json
   * For 'main': reads agents.defaults.model.primary
   * For others: reads agents.list[].model (or falls back to default primary)
   */
  readAgentModel(agentId: string): string | null {
    try {
      return this.readAgentModelConfig(agentId).resolvedModel;
    } catch {
      return null;
    }
  }

  readAgentModelConfig(agentId: string): AgentModelConfigSnapshot {
    const config = this.readConfigFile();
    const globalConfig = config ? this.readStoredModelValue(config?.agents?.defaults?.model) : {
      primary: null,
      hasFallbacks: false,
      fallbacks: [],
    };

    if (!config) {
      return {
        model: null,
        modelOverride: null,
        fallbackMode: 'inherit',
        fallbacks: [],
        resolvedModel: null,
      };
    }

    if (agentId === 'main') {
      const mainEntry = Array.isArray(config.agents?.list)
        ? config.agents.list.find((item: any) => item.id === 'main')
        : null;
      const mainModel = this.readStoredModelValue(mainEntry?.model);
      const resolvedModel = this.normalizeModelId(mainModel.primary || globalConfig.primary);
      const modelOverride = this.normalizeModelId(mainModel.primary || globalConfig.primary);

      return {
        model: resolvedModel,
        modelOverride,
        fallbackMode: this.resolveFallbackMode(mainModel.hasFallbacks, mainModel.fallbacks),
        fallbacks: mainModel.fallbacks,
        resolvedModel,
      };
    }

    const entry = Array.isArray(config.agents?.list)
      ? config.agents.list.find((item: any) => item.id === agentId)
      : null;
    const stored = this.readStoredModelValue(entry?.model);
    const resolvedModel = this.normalizeModelId(stored.primary || globalConfig.primary);

    return {
      model: resolvedModel,
      modelOverride: stored.primary,
      fallbackMode: this.resolveFallbackMode(stored.hasFallbacks, stored.fallbacks),
      fallbacks: stored.fallbacks,
      resolvedModel,
    };
  }

  readGlobalModelConfig(): GlobalModelConfigSnapshot {
    const config = this.readConfigFile();
    if (!config) {
      return { primary: null, fallbacks: [] };
    }

    const stored = this.readStoredModelValue(config?.agents?.defaults?.model);
    return {
      primary: stored.primary,
      fallbacks: stored.fallbacks,
    };
  }

  async updateGlobalFallbacks(fallbacks: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);
    this.validateModelIds(config, normalizedFallbacks);

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    const current = this.readStoredModelValue(config.agents.defaults.model);
    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }

    const previousSerialized = JSON.stringify({
      primary: current.primary,
      fallbacks: current.fallbacks,
    });

    if (current.primary) {
      config.agents.defaults.model.primary = current.primary;
    }
    config.agents.defaults.model.fallbacks = normalizedFallbacks;

    const nextSerialized = JSON.stringify({
      primary: this.normalizeModelId(config.agents.defaults.model.primary),
      fallbacks: this.normalizeFallbackIds(config.agents.defaults.model.fallbacks),
    });

    if (previousSerialized === nextSerialized) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }


  /**
   * Generic reader for any .md file in the agent workspace
   */
  readAgentFile(agentId: string, filename: string, defaultContent: string = ''): string {
    const workspaceDir = this.getWorkspacePath(agentId);
    const filePath = path.join(workspaceDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return defaultContent;
  }

  /**
   * Generic writer for any .md file in the agent workspace
   */
  writeAgentFile(agentId: string, filename: string, content: string): void {
    const workspaceDir = this.getWorkspacePath(agentId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, filename);
    fs.writeFileSync(filePath, content);
  }

  /**
   * Read USER.md content for a given agent. (kept for backwards compat)
   */
  readUserMd(agentId: string): string {
    return this.readAgentFile(agentId, 'USER.md', DEFAULT_USER_MD);
  }

  /**
   * Write USER.md content for a given agent. (kept for backwards compat)
   */
  writeUserMd(agentId: string, content: string): void {
    this.writeAgentFile(agentId, 'USER.md', content);
  }

  /**
   * Add or update agent entry in openclaw.json agents.list[]
   */
  private updateConfigList(
    agentId: string,
    workspaceDir: string,
    model?: string,
    fallbackMode: AgentFallbackMode = 'inherit',
    fallbacks: string[] = []
  ): boolean {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedModel = this.normalizeModelId(model);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);
    this.validateModelIds(config, [
      ...(normalizedModel ? [normalizedModel] : []),
      ...normalizedFallbacks,
    ]);

    const { entry, created } = this.ensureAgentEntry(config, agentId, workspaceDir);
    let changed = created;
    if (entry.workspace !== workspaceDir) {
      entry.workspace = workspaceDir;
      changed = true;
    }

    const modelChanged = this.assignModelValue(
      entry,
      this.buildStoredModelValue(normalizedModel, fallbackMode, normalizedFallbacks)
    );

    if (!changed && !modelChanged) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }
}

export default AgentProvisioner;
