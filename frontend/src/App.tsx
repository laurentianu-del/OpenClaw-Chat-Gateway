import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import LoginScreen from './components/LoginScreen';

export type ViewType = 'chat' | 'settings';
export type SettingsTab = 'gateway' | 'general' | 'models' | 'commands' | 'about';

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('chat');
  const [isConnected, setIsConnected] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('gateway');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null); // null = checking
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return localStorage.getItem('clawui_active_session') || '';
  });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<{id: string, name: string, characterId?: string, model?: string}[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  // --- History API Integration for Back Gesture ---
  useEffect(() => {
    // Initialize base state
    window.history.replaceState({ view: currentView, tab: settingsTab, menu: isMobileMenuOpen }, '');

    const handlePopState = (event: PopStateEvent) => {
      if (event.state && event.state.view) {
        // If menu was open and we're going back to a closed menu state, close it
        if (isMobileMenuOpen && !event.state.menu) {
          setIsMobileMenuOpen(false);
          return;
        }
        
        setCurrentView(event.state.view);
        if (event.state.tab) setSettingsTab(event.state.tab);
        if (event.state.menu !== undefined) setIsMobileMenuOpen(event.state.menu);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobileMenuOpen, currentView, settingsTab]);

  // Wrapper for view/tab changes that should push to history
  const navigateTo = (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => {
    const nextTab = tab || settingsTab;
    const nextOpen = openMenu !== undefined ? openMenu : isMobileMenuOpen;
    if (view !== currentView || nextTab !== settingsTab || nextOpen !== isMobileMenuOpen) {
      window.history.pushState({ view, tab: nextTab, menu: nextOpen }, '');
      setCurrentView(view);
      if (tab) setSettingsTab(tab);
      setIsMobileMenuOpen(nextOpen);
    }
  };

  // Sync activeSessionId to localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem('clawui_active_session', activeSessionId);
    }
  }, [activeSessionId]);

  const reloadSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data);
      setSessionsLoaded(true);
      // Auto-select first session if currently active is not in the list or empty
      if (data.length > 0) {
        setActiveSessionId(prev => {
          const exists = data.find((s: any) => s.id === prev);
          return exists ? prev : data[0].id;
        });
      }
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

  // Show login screen if not authenticated (and auth check is done)
  if (isAuthenticated === false) {
    return <LoginScreen onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  // Always render the real UI, but hide it until data is ready.
  // This prevents progressive paint / "expanding" artifacts.
  const appReady = isAuthenticated === true && sessionsLoaded;

  return (
    <div
      className="flex fixed inset-0 h-[100dvh] w-full overflow-visible bg-gray-50 text-gray-900 font-sans antialiased"
      style={{ opacity: appReady ? 1 : 0 }}
    >
      <Sidebar 
        currentView={currentView} 
        settingsTab={settingsTab} 
        activeSessionId={activeSessionId}
        setActiveSessionId={setActiveSessionId}
        isMobileMenuOpen={isMobileMenuOpen}
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        reloadSessions={reloadSessions}
        reorderSessions={reorderSessions}
        navigateTo={navigateTo}
      />
      <main className="flex-1 flex flex-col min-w-0 bg-white overflow-visible md:relative md:z-[60]">
        {currentView === 'chat' ? (
          <ChatView 
            isConnected={isConnected} 
            activeSessionId={activeSessionId} 
            onMenuClick={() => navigateTo(currentView, settingsTab, true)}
            sessions={sessions}
          />
        ) : (
          <SettingsView 
            isConnected={isConnected} 
            settingsTab={settingsTab} 
            onMenuClick={() => navigateTo(currentView, settingsTab, true)}
          />
        )}
      </main>
    </div>
  );
}
