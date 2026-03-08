import { useState } from 'react';
import { Plus, Settings, ArrowLeft, MessageSquare, X, Network, Terminal, Edit2, Trash2 } from 'lucide-react';
import { Reorder } from 'motion/react';
import { ViewType, SettingsTab } from '../App';

interface SidebarProps {
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  settingsTab?: SettingsTab;
  setSettingsTab?: (tab: SettingsTab) => void;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (isOpen: boolean) => void;
  sessions: {id: string, name: string}[];
  reloadSessions: () => Promise<void>;
  reorderSessions: (newSessions: {id: string, name: string}[]) => Promise<void>;
}

export default function Sidebar({ 
  currentView, 
  setCurrentView, 
  settingsTab = 'gateway', 
  setSettingsTab, 
  activeSessionId, 
  setActiveSessionId, 
  isMobileMenuOpen, 
  setIsMobileMenuOpen,
  sessions,
  reloadSessions,
  reorderSessions
}: SidebarProps) {
  
  // Modal State
  const [newSessionData, setNewSessionData] = useState({ name: '', description: '', prompt: '', characterId: '' });
  const [characters, setCharacters] = useState<any[]>([]);

  // Fetch characters on mount
  useState(() => {
    fetch('/api/characters')
      .then(res => res.json())
      .then(data => {
        if (data.success) setCharacters(data.characters);
      });
  });
  
  // Delete Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionData.name.trim()) return;

    try {
      let res;
      if (modalMode === 'create') {
        res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSessionData)
        });
      } else if (modalMode === 'edit' && editingSessionId) {
        res = await fetch(`/api/sessions/${editingSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSessionData)
        });
      }

      if (res && res.ok) {
        const data = await res.json();
        if (data.success) {
          setIsModalOpen(false);
          setNewSessionData({ name: '', description: '', prompt: '', characterId: '' });
          await reloadSessions();
          if (modalMode === 'create' && data.session?.id) {
            setActiveSessionId(data.session.id);
            setCurrentView('chat');
          }
        }
      }
    } catch (err) {
      console.error('Failed to handle modal submit:', err);
    }
  };

  const confirmDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingSessionId(id);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteSession = async () => {
    if (deletingSessionId) {
      try {
        const res = await fetch(`/api/sessions/${deletingSessionId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          setIsDeleteModalOpen(false);
          await reloadSessions();
          if (activeSessionId === deletingSessionId) {
            setActiveSessionId('5741707482'); 
          }
        }
      } catch (err) {
        console.error('Failed to delete session:', err);
      } finally {
        setIsDeleteModalOpen(false);
        setDeletingSessionId(null);
      }
    }
  };

  const handleStartEdit = async (e: React.MouseEvent, session: {id: string, name: string}) => {
    e.stopPropagation();
    
    // Fetch full session details to get description and prompt
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        const fullSession = data.find((s: any) => s.id === session.id);
        if (fullSession) {
          setNewSessionData({ 
            name: fullSession.name || '', 
            description: fullSession.description || '', 
            prompt: fullSession.prompt || '',
            characterId: fullSession.characterId || ''
          });
          setEditingSessionId(session.id);
          setModalMode('edit');
          setIsModalOpen(true);
        }
      }
    } catch (e) {
      console.error('Failed to fetch session details for editing', e);
    }
  };



  if (currentView === 'settings') {
    return (
      <>
        {/* Mobile Backdrop */}
        {isMobileMenuOpen && (
          <div 
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden" 
            onClick={() => setIsMobileMenuOpen(false)} 
          />
        )}
        <aside className={`fixed inset-y-0 left-0 z-50 w-72 flex-shrink-0 flex-col border-r border-gray-300 bg-gray-100 h-full transition-transform duration-300 md:relative md:translate-x-0 md:flex ${isMobileMenuOpen ? 'translate-x-0 flex' : '-translate-x-full hidden'}`}>
          <div className="p-6">
          <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">OpenClaw</div>
          <div className="text-2xl font-bold text-gray-400 tracking-widest uppercase leading-tight">CHAT GATEWAY</div>
        </div>
        <nav className="flex-1 px-4 py-2 space-y-1">
          <button 
            onClick={() => { setSettingsTab?.('gateway'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${settingsTab === 'gateway' ? 'text-blue-600 bg-blue-50/50' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            <Network className="w-5 h-5" />
            网关设置
          </button>
          <button 
            onClick={() => { setSettingsTab?.('general'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${settingsTab === 'general' ? 'text-blue-600 bg-blue-50/50' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            <Settings className="w-5 h-5" />
            通用设置
          </button>
          <button 
            onClick={() => { setSettingsTab?.('commands'); setIsMobileMenuOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${settingsTab === 'commands' ? 'text-blue-600 bg-blue-50/50' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            <Terminal className="w-5 h-5" />
            快捷指令
          </button>
        </nav>
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={() => { setCurrentView('chat'); setIsMobileMenuOpen(false); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-gray-600 hover:bg-gray-200 hover:text-gray-900 rounded-xl transition-all font-medium"
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm">返回对话</span>
          </button>
        </div>
      </aside>
      </>
    );
  }

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden" 
          onClick={() => setIsMobileMenuOpen(false)} 
        />
      )}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 flex-shrink-0 flex-col border-r border-gray-300 bg-gray-100 h-full transition-transform duration-300 md:relative md:translate-x-0 md:flex ${isMobileMenuOpen ? 'translate-x-0 flex' : '-translate-x-full hidden'}`}>
        <div className="p-6">
        <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">OpenClaw</div>
        <div className="text-2xl font-bold text-gray-400 tracking-widest uppercase leading-tight">CHAT GATEWAY</div>
      </div>

      <div className="px-4 pb-4">
        <button 
          onClick={() => {
            setModalMode('create');
            setEditingSessionId(null);
            setNewSessionData({ name: `新角色 ${sessions.length + 1}`, description: '', prompt: '', characterId: 'char_main' });
            setIsModalOpen(true);
          }}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl border border-blue-200 text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all bg-blue-50/50 font-bold text-sm active:scale-95"
        >
          <Plus className="w-5 h-5" />
          创建角色
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
        <div className="px-4 py-2 text-[12px] font-bold text-gray-400 uppercase tracking-widest flex items-center justify-between">
          <span>角色列表</span>
        </div>
        <Reorder.Group axis="y" values={sessions} onReorder={reorderSessions} className="space-y-1">
          {sessions.length > 0 ? (
            sessions.map((s) => (
              <Reorder.Item
                key={s.id}
                value={s}
                className="w-full"
              >
                <div
                  onClick={() => { setActiveSessionId(s.id); setCurrentView('chat'); setIsMobileMenuOpen(false); }}
                  className={`w-full group text-left py-2.5 px-3 text-sm rounded-xl transition-all flex items-center gap-3 cursor-pointer ${activeSessionId === s.id ? 'bg-white border border-gray-300 text-blue-600 font-bold' : 'text-gray-600 hover:bg-gray-200 font-medium border border-transparent hover:border-gray-300'}`}
                >
                  {/* Character Avatar or Icon */}
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${activeSessionId === s.id ? 'bg-blue-50' : 'bg-gray-100 group-hover:bg-white'}`}>
                    <MessageSquare className={`w-4 h-4 ${activeSessionId === s.id ? 'text-blue-500' : 'text-gray-400'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{s.name || `角色 ${s.id}`}</div>
                    {(s as any).characterId && (
                      <div className="text-[10px] text-gray-400 font-normal truncate">
                        {characters.find(c => c.id === (s as any).characterId)?.name || '自定义'}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => handleStartEdit(e, s)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={(e) => confirmDeleteSession(e, s.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </Reorder.Item>
            ))
          ) : (
            <div className="px-4 py-8 text-center bg-white/50 rounded-2xl border border-dashed border-gray-200 mt-2">
               <p className="text-sm text-gray-400 font-medium">暂无角色记录</p>
            </div>
          )}
        </Reorder.Group>
      </div>

      <div className="p-4 border-t border-gray-100 bg-gray-100/50">
        <button
          onClick={() => { setCurrentView('settings'); setIsMobileMenuOpen(false); }}
          className="flex items-center w-full py-3 px-4 text-gray-600 hover:text-gray-900 transition-all font-bold text-sm rounded-xl hover:bg-gray-200 gap-3"
        >
          <Settings className="w-5 h-5 text-gray-400" />
          系统设置
        </button>
      </div>

    </aside>

      {/* Create Persona Modal - outside aside to center properly */}
      {isModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-md overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-900">{modalMode === 'create' ? '创建角色' : '编辑角色'}</h3>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleModalSubmit} className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">角色名称 <span className="text-red-500">*</span></label>
                <input 
                  type="text" 
                  value={newSessionData.name}
                  onChange={e => setNewSessionData(prev => ({...prev, name: e.target.value}))}
                  autoFocus
                  placeholder="给角色起个名字，如：翻译助手"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">选择 Agent 身份</label>
                <div className="grid grid-cols-2 gap-2">
                  {characters.map(char => (
                    <button
                      key={char.id}
                      type="button"
                      onClick={() => {
                        setNewSessionData(prev => ({
                          ...prev, 
                          characterId: char.id,
                          prompt: prev.prompt || char.systemPrompt // Default to char's prompt if empty
                        }));
                      }}
                      className={`p-3 rounded-xl border text-sm text-left transition-all ${newSessionData.characterId === char.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'}`}
                    >
                      <div className="font-bold">{char.name}</div>
                      <div className="text-[10px] opacity-70 truncate">{char.description}</div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setNewSessionData(prev => ({...prev, characterId: ''}))}
                    className={`p-3 rounded-xl border text-sm text-left transition-all ${!newSessionData.characterId ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'}`}
                  >
                    <div className="font-bold">自定义</div>
                    <div className="text-[10px] opacity-70 truncate">手动设置 Prompt</div>
                  </button>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">角色描述</label>
                <input 
                  type="text" 
                  value={newSessionData.description}
                  onChange={e => setNewSessionData(prev => ({...prev, description: e.target.value}))}
                  placeholder="简短说明（选填）"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">提示词 (System Prompt)</label>
                <textarea 
                  value={newSessionData.prompt}
                  onChange={e => setNewSessionData(prev => ({...prev, prompt: e.target.value}))}
                  placeholder="告诉AI它的身份和注意事项（例如：你是一个精通Python的资深专家...）（选填）"
                  className="w-full h-32 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all resize-none"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button 
                  type="button" 
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 px-4 py-2.5 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl font-semibold transition-all"
                >
                  取消
                </button>
                <button 
                  type="submit" 
                  disabled={!newSessionData.name.trim()}
                  className="flex-1 px-4 py-2.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-semibold transition-all"
                >
                  {modalMode === 'create' ? '确认创建' : '保存修改'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal - outside aside to center properly */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">删除角色</h3>
              <p className="text-sm text-gray-500">
                确定要删除此角色吗？此操作将清空该角色所有对话记录且不可恢复。
              </p>
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
                onClick={handleDeleteSession}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
