import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Check, X, Loader2, Edit2, Trash2, Plus, Menu, Github, Send, ShoppingBag } from 'lucide-react';
import { SettingsTab } from '../App';

interface SettingsViewProps {
  isConnected: boolean;
  settingsTab: SettingsTab;
  onMenuClick: () => void;
}

export default function SettingsView({ settingsTab, onMenuClick }: SettingsViewProps) {
  // --- Gateway settings state ---
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [gatewaySaved, setGatewaySaved] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartSuccess, setRestartSuccess] = useState(false);

  // --- General settings state ---
  const [aiName, setAiName] = useState('我的小龙虾');
  const [loginEnabled, setLoginEnabled] = useState(false);
  const [loginPassword, setLoginPassword] = useState('123456');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const [aiNameError, setAiNameError] = useState('');
  const [openclawWorkspace, setOpenclawWorkspace] = useState('');

  const getVisualLength = (str: string) => {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 127) len += 2;
      else len += 1;
    }
    return len;
  };

  // --- Quick Commands state ---
  const [commands, setCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [newCommand, setNewCommand] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  // --- Shared Delete Modal State ---
  type DeleteTarget = { type: 'host'; value: string } | { type: 'command'; id: number } | { type: 'model'; id: string } | { type: 'endpoint'; name: string };
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteModalMessage, setDeleteModalMessage] = useState('');

  // --- Model Management State ---
  const [activeModelSubTab, setActiveModelSubTab] = useState<'endpoints' | 'models'>('endpoints');
  const [models, setModels] = useState<{ id: string; alias?: string; primary: boolean }[]>([]);
  const [newModelEndpoint, setNewModelEndpoint] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelAlias, setNewModelAlias] = useState('');
  const [modelError, setModelError] = useState('');
  const [modelSuccessTimestamp, setModelSuccessTimestamp] = useState(0);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState('');
  const editAliasInputRef = useRef<HTMLInputElement>(null);

  // --- Endpoint Management State ---
  type EndpointConfig = { id: string; baseUrl: string; apiKey: string; api: string };
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointConfig | null>(null);
  const [newEndpointData, setNewEndpointData] = useState<EndpointConfig>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });

  useEffect(() => {
    setTestResult(null);
  }, [url, token, password]);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setUrl(data.gatewayUrl || '');
        setToken(data.token || '');
        setPassword(data.password || '');
        if (data.aiName) setAiName(data.aiName);
        if (data.loginEnabled !== undefined) setLoginEnabled(data.loginEnabled);
        if (data.loginPassword) setLoginPassword(data.loginPassword);
        if (data.allowedHosts) setAllowedHosts(data.allowedHosts);
        if (data.openclawWorkspace) setOpenclawWorkspace(data.openclawWorkspace);
      })
      .catch(console.error);

    fetchCommands();
    fetchModels();
    fetchEndpoints();
  }, []);

  const fetchModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success) {
        setModels(data.models || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchEndpoints = async () => {
    try {
      const res = await fetch('/api/endpoints');
      const data = await res.json();
      if (data.success) {
        setEndpoints(data.endpoints || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchCommands = async () => {
    try {
      const res = await fetch('/api/commands');
      const data = await res.json();
      if (data.success) setCommands(data.commands);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    setGatewayError(false);
    if (!url.trim()) {
      alert('网关地址不能为空');
      setIsLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayUrl: url, token, password, openclawWorkspace }),
      });
      if (res.ok) {
        setGatewaySaved(true);
        setTimeout(() => setGatewaySaved(false), 2000);
      } else throw new Error('保存失败');
    } catch (err) {
      setGatewayError(true);
      setTimeout(() => setGatewayError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDetectWorkspace = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/config/detect-workspace');
      const data = await res.json();
      if (data.success && data.path) {
        setOpenclawWorkspace(data.path);
      } else {
        alert(data.message || '检测失败，请手动输入');
      }
    } catch (err) {
      console.error(err);
      alert('检测请求发生网络错误');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestartGateway = async () => {
    setIsRestarting(true);
    setRestartSuccess(false);
    try {
      const res = await fetch('/api/config/restart', { method: 'POST' });
      if (res.ok) {
        setRestartSuccess(true);
        setTimeout(() => setRestartSuccess(false), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '重启网关失败');
      }
    } catch (err) {
      console.error(err);
      alert('重启请求发生网络错误');
    } finally {
      setIsRestarting(false);
    }
  };

  const handleAddHost = async () => {
    if (!newHost.trim()) return;
    const updated = [...allowedHosts, newHost.trim()];
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedHosts: updated }),
      });
      if (res.ok) {
        setAllowedHosts(updated);
        setNewHost('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateHost = async () => {
    if (!newHost.trim() || !editingHost) return;
    const updated = allowedHosts.map(h => h === editingHost ? newHost.trim() : h);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedHosts: updated }),
      });
      if (res.ok) {
        setAllowedHosts(updated);
        setEditingHost(null);
        setNewHost('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startEditHost = (host: string) => {
    setEditingHost(host);
    setNewHost(host);
  };

  const handleRemoveHost = (hostToRemove: string) => {
    setDeleteTarget({ type: 'host', value: hostToRemove });
    setDeleteModalMessage(`确定要删除域名 "${hostToRemove}" 吗？删除后该域名将立即失去访问权限。`);
    setIsDeleteModalOpen(true);
  };

  const handleTest = async () => {
    setIsLoading(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayUrl: url, token, password }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, message: '测试连接失败' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveGeneral = async () => {
    setIsLoading(true);
    setGeneralError(false);
    if (!aiName.trim()) {
      setAiNameError('AI 名称不能为空');
      setIsLoading(false);
      return;
    }
    if (getVisualLength(aiName) > 20) {
      setAiNameError('AI 名称过长 (最多10个汉字或20个英文字符)');
      setIsLoading(false);
      return;
    }
    setAiNameError('');

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiName, loginEnabled, loginPassword }),
      });
      if (res.ok) {
        setGeneralSaved(true);
        setTimeout(() => setGeneralSaved(false), 2000);
      } else throw new Error('保存失败');
    } catch (err) {
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddCommand = async () => {
    if (!newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: newCommand, description: newDescription }),
      });
      if (res.ok) {
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateCommand = async () => {
    if (!editingId || !newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/commands/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: newCommand, description: newDescription }),
      });
      if (res.ok) {
        setEditingId(null);
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteCommand = (id: number) => {
    setDeleteTarget({ type: 'command', id });
    setDeleteModalMessage('确定要删除此快捷指令吗？此操作不可恢复。');
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'host') {
        const updated = allowedHosts.filter(h => h !== deleteTarget.value);
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedHosts: updated }),
        });
        if (res.ok) setAllowedHosts(updated);
      } else if (deleteTarget.type === 'command') {
        const res = await fetch(`/api/commands/${deleteTarget.id}`, { method: 'DELETE' });
        if (res.ok) fetchCommands();
      } else if (deleteTarget.type === 'model') {
        const res = await fetch('/api/models/manage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: deleteTarget.id }),
        });
        if (res.ok) {
          fetchModels();
          setModelSuccessTimestamp(Date.now());
        } else {
          const data = await res.json().catch(() => ({}));
          setModelError(data.error || '删除模型失败');
          setTimeout(() => setModelError(''), 3000);
        }
      } else if (deleteTarget.type === 'endpoint') {
        const res = await fetch('/api/endpoints/manage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: deleteTarget.name }),
        });
        if (res.ok) {
          fetchModels();
          fetchEndpoints();
          setModelSuccessTimestamp(Date.now());
        } else {
          const data = await res.json().catch(() => ({}));
          setModelError(data.error || '删除端点失败');
          setTimeout(() => setModelError(''), 3000);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsDeleteModalOpen(false);
      setDeleteTarget(null);
    }
  };

  const startEdit = (cmd: { id: number; command: string; description: string }) => {
    setEditingId(cmd.id);
    setNewCommand(cmd.command);
    setNewDescription(cmd.description);
  };

  const handleAddModel = async () => {
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setModelError('端点和模型名称不能为空');
      setTimeout(() => setModelError(''), 3000);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch('/api/models/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim(),
          alias: newModelAlias.trim() || undefined
        }),
      });
      if (res.ok) {
        setNewModelEndpoint('');
        setNewModelName('');
        setNewModelAlias('');
        fetchModels();
        setModelSuccessTimestamp(Date.now());
      } else {
        const data = await res.json().catch(() => ({}));
        setModelError(data.error || '添加模型失败');
        setTimeout(() => setModelError(''), 3000);
      }
    } catch (err) {
      console.error(err);
      setModelError('添加模型发生网络错误');
      setTimeout(() => setModelError(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteModel = (id: string, isPrimary: boolean) => {
    setDeleteTarget({ type: 'model', id });
    setDeleteModalMessage(
      `确定要删除模型 "${id}" 吗？\n${isPrimary ? '注意：这是当前的默认模型！\n' : ''}如果该模型已被智能体使用，它们将自动恢复为默认模型。`
    );
    setIsDeleteModalOpen(true);
  };

  const handleSetDefaultModel = async (id: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/models/manage/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        fetchModels();
        setModelSuccessTimestamp(Date.now());
      } else {
        const data = await res.json().catch(() => ({}));
        setModelError(data.error || '设置默认模型失败');
        setTimeout(() => setModelError(''), 3000);
      }
    } catch (err) {
      console.error(err);
      setModelError('设置默认模型发生网络错误');
      setTimeout(() => setModelError(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const startEditModel = (model: { id: string; alias?: string }) => {
    setEditingModelId(model.id);
    setEditingAlias(model.alias || '');
    setTimeout(() => editAliasInputRef.current?.focus(), 50);
  };

  const handleDeleteEndpoint = (endpoint: string, count: number) => {
    setDeleteTarget({ type: 'endpoint', name: endpoint });
    setDeleteModalMessage(`确定要删除端点 "${endpoint}" 吗？\n这将删除该端点下的全部 ${count} 个模型。\n如果其中包含默认模型或被智能体使用的模型，将自动恢复为系统默认。`);
    setIsDeleteModalOpen(true);
  };

  const cancelEditModel = () => {
    setEditingModelId(null);
    setEditingAlias('');
  };

  const handleSaveModelAlias = async () => {
    if (!editingModelId) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/models/manage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingModelId, alias: editingAlias }),
      });
      if (res.ok) {
        setEditingModelId(null);
        setEditingAlias('');
        fetchModels();
        setModelSuccessTimestamp(Date.now());
      } else {
        const data = await res.json().catch(() => ({}));
        setModelError(data.error || '修改别名失败');
        setTimeout(() => setModelError(''), 3000);
      }
    } catch (err) {
      console.error(err);
      setModelError('修改别名发生网络错误');
      setTimeout(() => setModelError(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const openAddEndpointModal = () => {
    setEditingEndpoint(null);
    setNewEndpointData({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
    setIsEndpointModalOpen(true);
  };

  const openEditEndpointModal = (ep: EndpointConfig) => {
    setEditingEndpoint(ep);
    setNewEndpointData({ ...ep });
    setIsEndpointModalOpen(true);
  };

  const handleSaveEndpoint = async () => {
    if (!newEndpointData.id.trim() || !newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setModelError('端点名称、URL和接口类型不能为空');
      setTimeout(() => setModelError(''), 3000);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEndpointData),
      });
      if (res.ok) {
        setIsEndpointModalOpen(false);
        fetchEndpoints();
        setModelSuccessTimestamp(Date.now());
      } else {
        const data = await res.json().catch(() => ({}));
        setModelError(data.error || '保存端点失败');
        setTimeout(() => setModelError(''), 3000);
      }
    } catch (err) {
      console.error(err);
      setModelError('保存端点发生网络错误');
      setTimeout(() => setModelError(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  // Get distinct endpoints from current models, merged with actual endpoints objects
  const knownEndpoints = Array.from(new Set([
    ...endpoints.map(ep => ep.id),
    ...models.map(m => m.id.split('/')[0]).filter(Boolean)
  ])).sort((a, b) => a.localeCompare(b));

  const headerTitle = settingsTab === 'gateway' ? '设置 - 网关' : settingsTab === 'general' ? '设置 - 通用' : settingsTab === 'commands' ? '设置 - 快捷指令' : settingsTab === 'models' ? '设置 - 模型管理' : '关于系统';

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      <header className="h-14 flex items-center px-4 sm:px-8 border-b border-gray-300 bg-white sticky top-0 z-10 gap-3">
        <button 
          className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1"
          onClick={onMenuClick}
        >
          <Menu className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold text-gray-900">{headerTitle}</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:p-8">
        <div className="max-w-2xl mx-auto space-y-6 sm:space-y-8">

          {/* Gateway Settings Tab */}
          {settingsTab === 'gateway' && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">连接设置</h3>
                <p className="text-sm text-gray-500 mb-6">配置连接到 OpenClaw 网关的终结点和凭据。</p>
                
                <div className="space-y-5 sm:space-y-6 bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      网关地址 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="ws://127.0.0.1:18789"
                      className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">Token</label>
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">密码</label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* OpenClaw Workspace Path */}
                  <div className="border-t border-gray-100 pt-5">
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                       OpenClaw 工作区路径
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={openclawWorkspace}
                        onChange={(e) => setOpenclawWorkspace(e.target.value)}
                        placeholder="/root/.openclaw/workspace-main"
                        className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={handleDetectWorkspace}
                        disabled={isLoading}
                        className="px-4 py-2.5 rounded-xl border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 transition-all text-sm font-medium disabled:opacity-50"
                      >
                        自动检测
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1.5">
                      配置此项后，上传的文件将存入该路径，以便 OpenClaw 识别。
                    </p>
                  </div>
                </div>

                {/* Domain Management Section */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">域名管理</h3>
                  <p className="text-sm text-gray-500 mb-4">管理允许访问此网页的域名（用于反向代理安全白名单）。</p>
                  
                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
                    <div className="flex flex-col sm:flex-row gap-3">
                      <input
                        type="text"
                        value={newHost}
                        onChange={(e) => setNewHost(e.target.value)}
                        placeholder="例如: openclaw.abc.com"
                        className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                      <button
                        onClick={editingHost ? handleUpdateHost : handleAddHost}
                        disabled={!newHost.trim()}
                        className="px-6 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2"
                      >
                        {editingHost ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                        {editingHost ? '保存' : '添加'}
                      </button>
                      {editingHost && (
                        <button
                          onClick={() => { setEditingHost(null); setNewHost(''); }}
                          className="px-4 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all font-bold text-sm"
                        >
                          取消
                        </button>
                      )}
                    </div>

                    <div className="space-y-2 max-h-[200px] overflow-y-auto pr-2">
                       {allowedHosts.map(host => (
                         <div key={host} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100 group">
                           <span className="text-sm font-mono text-gray-700">{host}</span>
                           <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                             <button 
                               onClick={() => startEditHost(host)}
                               className="p-1 px-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                               title="编辑"
                             >
                               <Edit2 className="w-4 h-4" />
                             </button>
                             <button 
                               onClick={() => handleRemoveHost(host)}
                               className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                               title="删除"
                             >
                               <Trash2 className="w-4 h-4" />
                             </button>
                           </div>
                         </div>
                       ))}
                       {allowedHosts.length === 0 && (
                         <div className="text-center py-6 text-gray-400 text-sm italic">
                           暂无添加的域名
                         </div>
                       )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row items-center justify-between pt-4 gap-4 sm:gap-0">
                <div className="flex items-center gap-4 w-full sm:w-auto justify-center sm:justify-start">
                  <button
                    onClick={handleTest}
                    disabled={isLoading}
                    className="inline-flex items-center px-5 py-2.5 border border-gray-200 text-sm font-medium rounded-xl text-gray-700 bg-white hover:bg-gray-50 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : '测试连接'}
                  </button>
                  
                  {testResult && (
                    <div className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-600' : 'text-red-500'} animate-in fade-in zoom-in-95 duration-200`}>
                      {testResult.success ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      <span className="font-semibold">{testResult.success ? '测试连接成功' : (testResult.message === '测试连接失败' ? '测试连接失败' : `测试连接失败: ${testResult.message}`)}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap sm:flex-nowrap gap-3 items-center w-full sm:w-auto justify-center sm:justify-end">
                  <button
                    onClick={handleRestartGateway}
                    disabled={!testResult?.success || isRestarting}
                    className={`inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-xl transition-all ${
                      testResult?.success 
                        ? 'text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200' 
                        : 'text-gray-400 bg-gray-100 border border-gray-200 cursor-not-allowed'
                    }`}
                  >
                    {isRestarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Loader2 className="w-4 h-4" />}
                    {restartSuccess ? '已重连' : '重启网关'}
                  </button>

                  <div className="h-6 w-px bg-gray-200 mx-1"></div>
                  {gatewayError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> 保存出错
                    </span>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={isLoading || !testResult?.success}
                    className={`inline-flex items-center gap-2 px-6 sm:px-8 py-2.5 text-sm font-medium rounded-xl text-white transition-all ${
                      isLoading || !testResult?.success
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : gatewaySaved ? <><Check className="w-4 h-4" /> 已保存</> : '保存设置'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* General Settings Tab */}
          {settingsTab === 'general' && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">通用设置</h3>
                <p className="text-sm text-gray-500 mb-6">配置 AI 助手的基本信息和系统安全选项。</p>

                <div className="space-y-6 bg-white p-6 rounded-2xl border border-gray-200">
                  {/* AI Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      AI 名称 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={aiName}
                      onChange={(e) => {
                        setAiName(e.target.value);
                        if (aiNameError) setAiNameError('');
                      }}
                      placeholder="我的小龙虾"
                      className={`block w-full px-4 py-2.5 rounded-xl border ${aiNameError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${aiNameError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
                    />
                    {aiNameError ? (
                      <p className="text-xs text-red-500 mt-1.5 font-medium">{aiNameError}</p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1.5">AI 在对话中显示的名称，限制10个汉字（20个英文字符）</p>
                    )}
                  </div>

                  {/* Login Password Toggle */}
                  <div className="border-t border-gray-100 pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-900">登录密码保护</label>
                        <p className="text-xs text-gray-400 mt-0.5">开启后，访问网页需要输入登录密码</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLoginEnabled(!loginEnabled)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          loginEnabled ? 'bg-blue-600' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                            loginEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>

                    {loginEnabled && (
                      <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                        <label className="block text-sm font-medium text-gray-900 mb-2">登录密码</label>
                        <div className="relative">
                          <input
                            type={showLoginPassword ? "text" : "password"}
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            placeholder="请输入登录密码"
                            className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowLoginPassword(!showLoginPassword)}
                            className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                          >
                            {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5">默认密码为 123456</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-center sm:justify-end pt-4">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  {generalError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> 保存出错
                    </span>
                  )}
                  <button
                    onClick={handleSaveGeneral}
                    disabled={isLoading}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : generalSaved ? <><Check className="w-4 h-4" /> 已保存</> : '保存设置'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Quick Commands Management Tab */}
          {settingsTab === 'commands' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">快捷指令</h3>
                <p className="text-sm text-gray-500 mb-6">管理聊天框中可用的快捷指令。</p>

                {/* Add/Edit Form */}
                <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 mb-6">
                  <div className="flex flex-col sm:flex-row gap-4 items-end">
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">指令 (需以 / 开头)</label>
                      <input
                        type="text"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                        placeholder="/models"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                    </div>
                    <div className="flex-[2] w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">说明</label>
                      <input
                        type="text"
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                        placeholder="列出所有可用的模型"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                    </div>
                    <div className="flex w-full sm:w-auto gap-2">
                      <button
                        onClick={editingId ? handleUpdateCommand : handleAddCommand}
                        disabled={isLoading || !newCommand || !newDescription}
                        className="h-[42px] px-6 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex-1 sm:flex-none flex items-center justify-center gap-2"
                      >
                        {editingId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                        {editingId ? '保存' : '新增'}
                      </button>
                      {editingId && (
                        <button
                          onClick={() => { setEditingId(null); setNewCommand(''); setNewDescription(''); }}
                          className="h-[42px] px-4 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all font-bold text-sm flex-1 sm:flex-none"
                        >
                          取消
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Commands List */}
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest w-1/3">指令</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">说明</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right w-24">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {commands.map((cmd) => (
                        <tr key={cmd.id} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-6 py-4 text-sm font-mono font-bold text-blue-600">{cmd.command}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{cmd.description}</td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button 
                                onClick={() => startEdit(cmd)}
                                className="p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                                title="编辑"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={() => handleDeleteCommand(cmd.id)}
                                className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                title="删除"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {commands.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-6 py-12 text-center text-gray-400 text-sm italic">
                            暂无快捷指令
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Model Management Tab */}
          {settingsTab === 'models' && (
            <div className="space-y-6">
              {/* Sub-tabs for Model Management */}
              <div className="flex bg-white rounded-xl border border-gray-200 p-1 mb-2">
                <button
                  onClick={() => setActiveModelSubTab('endpoints')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-lg transition-all ${
                    activeModelSubTab === 'endpoints'
                      ? 'bg-blue-50 text-blue-600 shadow-sm'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  端点管理
                </button>
                <button
                  onClick={() => setActiveModelSubTab('models')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-lg transition-all ${
                    activeModelSubTab === 'models'
                      ? 'bg-blue-50 text-blue-600 shadow-sm'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  模型列表
                </button>
              </div>

              {activeModelSubTab === 'models' && (
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">添加模型</h3>
                <p className="text-sm text-gray-500 mb-6">选择端点并输入模型 ID 来添加新模型到 openclaw.json 配置中。</p>
                
                {modelError && (
                  <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                    <X className="w-4 h-4 shrink-0" />
                    {modelError}
                  </div>
                )}
                {modelSuccessTimestamp > 0 && Date.now() - modelSuccessTimestamp < 3000 && (
                  <div className="mb-4 p-3 bg-green-50 text-green-600 text-sm rounded-xl border border-green-100 flex items-center gap-2 animate-in fade-in duration-300">
                    <Check className="w-4 h-4 shrink-0" />
                    操作成功，网关配置已更新
                  </div>
                )}

                <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 mb-6">
                  <div className="flex flex-col sm:flex-row gap-4 items-end">
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">提供商端点 (Endpoint)</label>
                      <input
                        list="known-endpoints"
                        type="text"
                        value={newModelEndpoint}
                        onChange={(e) => setNewModelEndpoint(e.target.value)}
                        placeholder="例如: openai"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                      <datalist id="known-endpoints">
                        {knownEndpoints.map(ep => (
                          <option key={ep} value={ep} />
                        ))}
                      </datalist>
                    </div>
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">模型标识 (Model ID)</label>
                      <input
                        type="text"
                        value={newModelName}
                        onChange={(e) => setNewModelName(e.target.value)}
                        placeholder="例如: gpt-5.4"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                    </div>
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">显示别名 (可选)</label>
                      <input
                        type="text"
                        value={newModelAlias}
                        onChange={(e) => setNewModelAlias(e.target.value)}
                        placeholder="例如: GPT 5.4"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                    </div>
                    <div className="flex w-full sm:w-auto gap-2">
                      <button
                        onClick={handleAddModel}
                        disabled={isLoading || !newModelEndpoint.trim() || !newModelName.trim()}
                        className="h-[42px] px-6 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex-1 sm:flex-none flex items-center justify-center gap-2"
                      >
                        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                        新增
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              )}

              {activeModelSubTab === 'endpoints' && (
              <div>
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">端点管理</h3>
                    <p className="text-sm text-gray-500">管理 API 服务提供商的连接设置，如 Base URL 和 API Key。</p>
                  </div>
                  <button
                    onClick={openAddEndpointModal}
                    className="h-[38px] px-4 rounded-xl bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 transition-all flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    新增端点
                  </button>
                </div>
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-6">
                  {knownEndpoints.length === 0 ? (
                    <div className="px-6 py-6 text-center text-gray-400 text-sm">暂无端点</div>
                  ) : (
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-200">
                          <th className="px-6 py-3 font-medium text-gray-500 text-sm">端点名称</th>
                          <th className="px-6 py-3 font-medium text-gray-500 text-sm">接口类型</th>
                          <th className="px-6 py-3 font-medium text-gray-500 text-sm">Base URL</th>
                          <th className="px-6 py-3 font-medium text-gray-500 text-sm">模型数量</th>
                          <th className="px-6 py-3 text-right w-24">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {knownEndpoints.map(epName => {
                          const epCount = models.filter(m => m.id.startsWith(`${epName}/`)).length;
                          const epConfig = endpoints.find(e => e.id === epName) || { id: epName, baseUrl: '', apiKey: '', api: 'openai-completions' };
                          
                          // Convert api internal name to display name
                          const displayApi = epConfig.api === 'openai-completions' ? 'OpenAI' : 
                                             epConfig.api === 'anthropic-messages' ? 'Anthropic' :
                                             epConfig.api === 'google-genai' ? 'Gemini' : epConfig.api;

                          return (
                            <tr key={epName} className="hover:bg-gray-50/50 transition-colors group">
                              <td className="px-6 py-4 font-medium text-gray-800 text-base">{epName}</td>
                              <td className="px-6 py-4 text-gray-500 text-sm">
                                <span className="px-2 py-0.5 rounded-md bg-gray-100/80 border border-gray-200 text-xs font-mono">
                                  {displayApi}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-gray-500 text-sm">
                                <div className="truncate max-w-[200px]" title={epConfig.baseUrl}>
                                  {epConfig.baseUrl || '-'}
                                </div>
                              </td>
                              <td className="px-6 py-4 text-gray-500 text-sm">{epCount} 个</td>
                              <td className="px-6 py-4 text-right">
                                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                  <button
                                    onClick={() => openEditEndpointModal(epConfig)}
                                    className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                    title="编辑端点"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteEndpoint(epName, epCount)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                    title="删除整个端点"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
              )}

              {activeModelSubTab === 'models' && (
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">现有模型列表</h3>
                <p className="text-sm text-gray-500 mb-4">按模型 ID 升序排列，悬停列可进行编辑别名、设为默认或删除操作。</p>
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 font-medium text-gray-500 whitespace-nowrap text-sm">模型 ID</th>
                        <th className="px-4 py-3 font-medium text-gray-500 whitespace-nowrap text-sm">别名</th>
                        <th className="px-4 py-3 font-medium text-gray-500 whitespace-nowrap w-24 text-sm">状态</th>
                        <th className="px-4 py-3 font-medium text-gray-500 whitespace-nowrap text-right w-32 text-sm">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {models.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                            暂无模型配置
                          </td>
                        </tr>
                      ) : (
                        [...models].sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' })).map((model) => (
                          <tr key={model.id} className={`hover:bg-gray-50/50 transition-colors text-base ${editingModelId === model.id ? 'bg-blue-50/30' : 'group'}`}>
                            <td className="px-4 py-4 text-gray-700">{model.id}</td>
                            <td className="px-4 py-3 text-gray-600">
                              {editingModelId === model.id ? (
                                <input
                                  ref={editAliasInputRef}
                                  type="text"
                                  value={editingAlias}
                                  onChange={(e) => setEditingAlias(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveModelAlias();
                                    if (e.key === 'Escape') cancelEditModel();
                                  }}
                                  placeholder="输入别名（可留空）"
                                  className="w-full px-2 py-1 text-sm border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                />
                              ) : (
                                model.alias || <span className="text-gray-300">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {model.primary ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                                  默认
                                </span>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {editingModelId === model.id ? (
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    onClick={handleSaveModelAlias}
                                    disabled={isLoading}
                                    className="p-1.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                                    title="保存"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={cancelEditModel}
                                    className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                    title="取消"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => startEditModel(model)}
                                    className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                    title="修改别名"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  {!model.primary && (
                                    <button
                                      onClick={() => handleSetDefaultModel(model.id)}
                                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                      title="设为默认"
                                    >
                                      <Check className="w-4 h-4" />
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleDeleteModel(model.id, model.primary)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    title="删除"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              )}
            </div>
          )}

          {/* About System Tab */}

          {settingsTab === 'about' && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="bg-white rounded-3xl border border-gray-200 p-10 w-full max-w-lg text-center flex flex-col items-center">
                
                {/* Logo Section */}
                <div className="mb-6 w-max text-center flex flex-col items-center">
                  <div className="text-[2.5rem] font-black text-[#1a1c1e] tracking-tight leading-tight mb-0.5">OpenClaw</div>
                  <div className="text-[1.1rem] font-bold text-[#94a3b8] tracking-[0.35em] uppercase leading-tight">CHAT GATEWAY</div>
                </div>

                {/* Version Info */}
                <div className="space-y-4 mb-8">
                  <div className="text-2xl font-medium text-gray-800">Ver: 1.00</div>
                  <div>
                    <a href="#" className="text-[#3b82f6] hover:text-blue-700 font-medium text-lg transition-colors underline-offset-4 hover:underline">
                      检查新版本
                    </a>
                  </div>
                </div>

                {/* Author Info */}
                <div className="text-xl font-medium text-gray-700 mb-10">
                  安格视界 / AnGeWorld
                </div>

                {/* Links Row */}
                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4 mb-6">
                  <a 
                    href="https://github.com/liandu2024/OpenClaw-Chat-Gateway" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-2 text-[#3b82f6] hover:text-blue-700 transition-colors group text-[13px] sm:text-[15px] font-medium"
                  >
                    <Github className="w-5 h-5 text-gray-900 group-hover:-translate-y-0.5 transition-transform" />
                    <span>Github</span>
                  </a>
                  <a 
                    href="https://t.me/angeworld2024" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-2 text-[#3b82f6] hover:text-blue-700 transition-colors group text-[13px] sm:text-[15px] font-medium"
                  >
                    <Send className="w-5 h-5 text-[#3b82f6] group-hover:-translate-y-0.5 transition-transform" />
                    <span>安格视界TG群</span>
                  </a>
                  <a 
                    href="https://blog.angeworld.cc/market" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-2 text-[#3b82f6] hover:text-blue-700 transition-colors group text-[13px] sm:text-[15px] font-medium"
                  >
                    <ShoppingBag className="w-5 h-5 text-[#ef4444] group-hover:-translate-y-0.5 transition-transform" />
                    <span>安格超市</span>
                  </a>
                </div>

                {/* API Button Row */}
                <div className="w-full flex justify-center mb-8 px-2">
                  <a 
                    href="https://ai.opendoor.cn" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center justify-center px-6 py-2.5 rounded-xl sm:rounded-full bg-[#fefce8] border border-blue-300 text-[#3b82f6] hover:bg-yellow-100 hover:border-blue-400 transition-all font-bold text-[11px] min-[380px]:text-[12px] sm:text-[14px] max-w-full text-center shadow-sm"
                  >
                    芝麻开门 AI 接口 : https://ai.opendoor.cn
                  </a>
                </div>

              </div>
            </div>
          )}

        </div>
      </div>

      {/* Shared Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">确认删除</h3>
              <p className="text-sm text-gray-500">{deleteModalMessage}</p>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                取消
              </button>
              <button
                type="button"
                onClick={executeDelete}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Endpoint Add/Edit Modal */}
      {isEndpointModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsEndpointModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-md overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">
                {editingEndpoint ? '编辑端点设置' : '新增端点'}
              </h3>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  端点名称 (ID) <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newEndpointData.id}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, id: e.target.value })}
                  disabled={!!editingEndpoint}
                  placeholder="例如: openai, my-company"
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  接口类型 <span className="text-red-500">*</span>
                </label>
                <select
                  value={newEndpointData.api}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, api: e.target.value })}
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                >
                  <option value="openai-completions">OpenAI 兼容 (Chat Completions)</option>
                  <option value="anthropic-messages">Anthropic (Messages)</option>
                  <option value="google-genai">Google Gemini (GenAI)</option>
                  <option value="cohere-chat">Cohere Chat</option>
                  <option value="mistral-chat">Mistral Chat</option>
                </select>
                <p className="text-xs text-gray-500 mt-1.5 ml-1">取决于提供商的底层 API 格式，通常为 OpenAI 兼容。</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  Base URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newEndpointData.baseUrl}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={newEndpointData.apiKey}
                    onChange={(e) => setNewEndpointData({ ...newEndpointData, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsEndpointModalOpen(false)}
                className="flex-[0.8] px-4 py-2.5 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveEndpoint}
                disabled={isLoading}
                className="flex-[1.2] px-4 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                保存端点
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
