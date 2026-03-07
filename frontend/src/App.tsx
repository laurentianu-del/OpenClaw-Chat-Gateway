import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import LoginScreen from './components/LoginScreen';

export type ViewType = 'chat' | 'settings';
export type SettingsTab = 'gateway' | 'general' | 'commands';

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('chat');
  const [isConnected, setIsConnected] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('gateway');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null); // null = checking
  const [activeSessionId, setActiveSessionId] = useState<string>('5741707482');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<{id: string, name: string}[]>([]);

  const reloadSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data);
    } catch (err) {
      console.error('Failed to reload sessions:', err);
    }
  };

  const reorderSessions = async (newSessions: {id: string, name: string}[]) => {
    // Optimistic update
    setSessions(newSessions);
    try {
      await fetch('/api/sessions/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: newSessions.map(s => s.id) }),
      });
    } catch (err) {
      console.error('Failed to save session order:', err);
      // Fallback on failure
      reloadSessions();
    }
  };

  // Check if login is required on mount and periodically
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const token = localStorage.getItem('clawui_auth_token');
        const url = token ? `/api/auth/check?token=${encodeURIComponent(token)}` : '/api/auth/check';
        const res = await fetch(url);
        const data = await res.json();
        if (data.loginRequired) {
          localStorage.removeItem('clawui_auth_token');
          setIsAuthenticated(false);
        } else {
          setIsAuthenticated(true);
        }
      } catch {
        // If can't reach server, allow access (offline mode)
        setIsAuthenticated(prev => prev === null ? true : prev);
      }
    };
    checkAuth();
    
    // Periodically poll auth to log out instantly on password change
    const tokenTimer = setInterval(checkAuth, 3000);
    return () => clearInterval(tokenTimer);
  }, []);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/gateway/status');
        if (res.ok) {
          const data = await res.json();
          setIsConnected(!!data.connected); 
        } else {
          setIsConnected(false);
        }
      } catch (e) {
        setIsConnected(false);
      }
    };

    checkStatus();
    reloadSessions();
    const timer = setInterval(checkStatus, 10000);
    return () => clearInterval(timer);
  }, []);

  // Loading state while checking auth
  if (isAuthenticated === null) {
    return (
      <div className="flex fixed inset-0 h-[100dvh] w-full items-center justify-center bg-gray-50">
        <div className="text-gray-400 text-sm font-medium animate-pulse">加载中...</div>
      </div>
    );
  }

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return <LoginScreen onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="flex fixed inset-0 h-[100dvh] w-full overflow-hidden bg-gray-50 text-gray-900 font-sans antialiased">
      <Sidebar 
        currentView={currentView} 
        setCurrentView={setCurrentView} 
        settingsTab={settingsTab} 
        setSettingsTab={setSettingsTab} 
        activeSessionId={activeSessionId}
        setActiveSessionId={setActiveSessionId}
        isMobileMenuOpen={isMobileMenuOpen}
        setIsMobileMenuOpen={setIsMobileMenuOpen}
        sessions={sessions}
        reloadSessions={reloadSessions}
        reorderSessions={reorderSessions}
      />
      <main className="flex-1 flex flex-col min-w-0 bg-white">
        {currentView === 'chat' ? (
          <ChatView 
            isConnected={isConnected} 
            activeSessionId={activeSessionId} 
            onMenuClick={() => setIsMobileMenuOpen(true)}
            sessions={sessions}
          />
        ) : (
          <SettingsView 
            isConnected={isConnected} 
            settingsTab={settingsTab} 
            onMenuClick={() => setIsMobileMenuOpen(true)}
          />
        )}
      </main>
    </div>
  );
}
