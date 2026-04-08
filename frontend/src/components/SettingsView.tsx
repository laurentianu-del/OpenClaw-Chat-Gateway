import { useState, useEffect, useRef, Fragment, type ChangeEvent } from 'react';
import { Eye, EyeOff, Check, X, Loader2, Edit2, Trash2, Plus, Menu, Github, Send, ShoppingBag, Activity, Globe, Zap, Wrench, ArrowUpDown, Link2, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsTab } from '../App';
import { applyLanguagePreference, normalizeLanguage, type SupportedLanguage } from '../i18n';
import {
  normalizeChatHistoryPageRounds,
  persistChatHistoryPageRounds,
  readChatHistoryPageRounds,
} from '../utils/historyPagination';
import ModelFallbackEditor, { type ModelFallbackMode } from './ModelFallbackEditor';
import ModelSinglePicker from './ModelSinglePicker';

interface SettingsViewProps {
  isConnected: boolean;
  settingsTab: SettingsTab;
  onMenuClick: () => void;
  onModelsChanged?: () => void;
}

function resolveStructuredErrorDisplay(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: (key: string, options?: any) => string,
  fallbackKey: string
): { message: string; detail: string } {
  let message = '';
  let detail = typeof data.errorDetail === 'string' && data.errorDetail.trim() ? data.errorDetail.trim() : '';

  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      message = translated;
    }
  }

  if (!message && typeof data.error === 'string' && data.error.trim()) {
    message = data.error.trim();
  }

  if (!message && typeof data.message === 'string' && data.message.trim()) {
    message = data.message.trim();
  }

  if (!message && detail) {
    message = detail;
    detail = '';
  }

  return {
    message: message || t(fallbackKey),
    detail,
  };
}

type TestStatus = {
  status: 'testing' | 'success' | 'error';
  message?: string;
  detail?: string;
};

type InlineErrorState = {
  message: string;
  detail: string;
};

type BrowserHealthIssue = 'permissions' | 'disabled' | 'stopped' | 'detect-error' | 'timeout' | 'unknown';

type BrowserHealthConfig = {
  enabled: boolean | null;
  headless: boolean | null;
  profile: string | null;
  executablePath?: string | null;
  noSandbox?: boolean | null;
  attachOnly?: boolean | null;
  cdpPort?: number | null;
};

type BrowserHealthRuntime = {
  profile: string | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
};

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
  validationSucceeded?: boolean | null;
  validationDetail?: string | null;
  config?: BrowserHealthConfig | null;
  runtime?: BrowserHealthRuntime | null;
};

type BrowserHealthNotice = {
  tone: 'success' | 'warning';
  message: string;
};

type BrowserHeadedModeConfig = {
  headless: boolean;
  headedModeEnabled: boolean;
};

type AppVersionInfo = {
  appName: string;
  version: string;
  releaseTag: string;
  commit: string | null;
  buildTime: string | null;
  repositoryUrl: string | null;
  openclawVersion: string | null;
};

type LatestVersionInfo = {
  appName: string;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  status: 'update_available' | 'up_to_date' | 'no_release';
  releaseTag: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  repositoryUrl: string | null;
  canUpgrade: boolean;
  upgradeSupported: boolean;
  upgradeReasonCode?: string | null;
  upgradeReason: string | null;
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

type UpdateStatusInfo = {
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

const EMPTY_INLINE_ERROR: InlineErrorState = { message: '', detail: '' };

type UpdateProgressTone = 'neutral' | 'brand' | 'success' | 'error';

type UpdatePhaseVisual = {
  progress: number;
  labelKey: string;
};

type UpdateProgressLayout = 'compact' | 'expanded';

const UPDATE_PHASE_VISUALS: Record<string, UpdatePhaseVisual> = {
  'downloading-script': { progress: 10, labelKey: 'settings.about.updateProgressFetchingCode' },
  'detect-service': { progress: 18, labelKey: 'settings.about.updateProgressPreparing' },
  'git-pull': { progress: 26, labelKey: 'settings.about.updateProgressFetchingCode' },
  'install-dependencies': { progress: 40, labelKey: 'settings.about.updateProgressInstallingDependencies' },
  'build': { progress: 58, labelKey: 'settings.about.updateProgressBuilding' },
  'patch-config': { progress: 68, labelKey: 'settings.about.updateProgressApplyingConfig' },
  'reconcile-openclaw-runtime': { progress: 78, labelKey: 'settings.about.updateProgressReconcilingRuntime' },
  'repair-openclaw-device': { progress: 86, labelKey: 'settings.about.updateProgressRepairingDevice' },
  'recover-browser-runtime': { progress: 92, labelKey: 'settings.about.updateProgressRecoveringBrowser' },
  'setup-service': { progress: 96, labelKey: 'settings.about.updateProgressSettingUpService' },
  'service-restart': { progress: 98, labelKey: 'settings.about.updateProgressSettingUpService' },
  'complete': { progress: 100, labelKey: 'settings.about.updateProgressFinishing' },
};

function joinDistinctLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
  }
  return lines.join('\n');
}

export default function SettingsView({ settingsTab, onMenuClick, onModelsChanged }: SettingsViewProps) {
  const { t, i18n } = useTranslation();

  const openSettingsErrorModal = (message: string, detail = '') => {
    setGatewayErrorMessage(message);
    setGatewayErrorDetail(detail);
    setGatewayErrorModalOpen(true);
  };

  // --- Gateway settings state ---
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [gatewaySaved, setGatewaySaved] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const [isDetectingAll, setIsDetectingAll] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [detectedOpenClawVersion, setDetectedOpenClawVersion] = useState('');
  const [maxPermissions, setMaxPermissions] = useState(false);
  const [isTogglingPermissions, setIsTogglingPermissions] = useState(false);
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editHostValue, setEditHostValue] = useState('');
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartSuccess, setRestartSuccess] = useState(false);
  const [browserHealth, setBrowserHealth] = useState<BrowserHealthSnapshot | null>(null);
  const [browserHealthError, setBrowserHealthError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [browserHealthNotice, setBrowserHealthNotice] = useState<BrowserHealthNotice | null>(null);
  const [isCheckingBrowserHealth, setIsCheckingBrowserHealth] = useState(false);
  const [isSelfHealingBrowser, setIsSelfHealingBrowser] = useState(false);
  const [browserHeadedModeEnabled, setBrowserHeadedModeEnabled] = useState<boolean | null>(null);
  const [isLoadingBrowserHeadedMode, setIsLoadingBrowserHeadedMode] = useState(false);
  const [isTogglingBrowserHeadedMode, setIsTogglingBrowserHeadedMode] = useState(false);
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);
  const [appVersionError, setAppVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isLoadingAppVersion, setIsLoadingAppVersion] = useState(false);
  const [latestVersionInfo, setLatestVersionInfo] = useState<LatestVersionInfo | null>(null);
  const [latestVersionError, setLatestVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isCheckingLatestVersion, setIsCheckingLatestVersion] = useState(false);
  const [updateStatusInfo, setUpdateStatusInfo] = useState<UpdateStatusInfo | null>(null);
  const [isUpdateCancelModalOpen, setIsUpdateCancelModalOpen] = useState(false);
  const [isCancellingUpdate, setIsCancellingUpdate] = useState(false);

  // --- General settings state ---
  const [aiName, setAiName] = useState(() => t('settings.general.aiNamePlaceholder'));
  const [loginEnabled, setLoginEnabled] = useState(false);
  const [loginPassword, setLoginPassword] = useState('123456');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const [aiNameError, setAiNameError] = useState<'' | 'required' | 'tooLong'>('');
  const [openclawWorkspace, setOpenclawWorkspace] = useState('');
  const [historyPageRoundsInput, setHistoryPageRoundsInput] = useState(() => String(readChatHistoryPageRounds()));

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
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('openclaw_expandedEndpoints');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  useEffect(() => {
    localStorage.setItem('openclaw_expandedEndpoints', JSON.stringify(Array.from(expandedEndpoints)));
  }, [expandedEndpoints]);

  const toggleEndpointExpanded = (epName: string) => {
    setExpandedEndpoints(prev => {
      const next = new Set(prev);
      if (next.has(epName)) next.delete(epName);
      else next.add(epName);
      return next;
    });
  };
  const [models, setModels] = useState<{ id: string; alias?: string; primary: boolean; input: string[] }[]>([]);
  const [defaultModelId, setDefaultModelId] = useState('');
  const [defaultModelError, setDefaultModelError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSavingDefaultModel, setIsSavingDefaultModel] = useState(false);
  const [globalFallbacks, setGlobalFallbacks] = useState<string[]>([]);
  const [globalFallbackMode, setGlobalFallbackMode] = useState<ModelFallbackMode>('disabled');
  const [globalFallbackError, setGlobalFallbackError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [, setIsSavingGlobalFallbacks] = useState(false);
  const globalFallbackAutosaveTimerRef = useRef<number | null>(null);
  const globalFallbackAutosaveUnlockTimerRef = useRef<number | null>(null);
  const suppressGlobalFallbackAutosaveRef = useRef(true);
  const [newModelEndpoint, setNewModelEndpoint] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelAlias, setNewModelAlias] = useState('');
  const [newModelInput, setNewModelInput] = useState<string[]>(['text']);
  const [modelError, setModelError] = useState('');

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState('');
  const [editingInput, setEditingInput] = useState<string[]>([]);
  const [gatewayErrorModalOpen, setGatewayErrorModalOpen] = useState(false);
  const [gatewayErrorMessage, setGatewayErrorMessage] = useState('');
  const [gatewayErrorDetail, setGatewayErrorDetail] = useState('');
  const [isEndpointDropdownOpen, setIsEndpointDropdownOpen] = useState(false);
  const [endpointSearchQuery, setEndpointSearchQuery] = useState('');

  const [testModelMessage, setTestModelMessage] = useState('');
  
  const [addModelTestStatus, setAddModelTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [addModelTestMessage, setAddModelTestMessage] = useState('');
  const [showForceAddModal, setShowForceAddModal] = useState(false);
  const editAliasInputRef = useRef<HTMLInputElement>(null);
  const [modelActionError, setModelActionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);

  // --- Model Discovery State ---
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const discoverAbortControllerRef = useRef<AbortController | null>(null);
  const testAllAbortControllerRef = useRef<AbortController | null>(null);
  const [addModelError, setAddModelError] = useState('');
  const [addModelErrorDetail, setAddModelErrorDetail] = useState('');
  const [existingModelTestStatus, setExistingModelTestStatus] = useState<Record<string, TestStatus>>({}); 

  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [showOnlyConnected, setShowOnlyConnected] = useState(false);
  const [individualTestStatus, setIndividualTestStatus] = useState<Record<string, TestStatus>>({});
  
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [modelDropdownMaxHeight, setModelDropdownMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (isModelDropdownOpen && dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      const availableSpace = window.innerHeight - (rect.top + 80) - 24;
      setModelDropdownMaxHeight(Math.max(200, availableSpace));
    }
  }, [isModelDropdownOpen]);

  // --- Endpoint Management State ---
  type EndpointConfig = { id: string; baseUrl: string; apiKey: string; api: string };
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [isAddModelModalOpen, setIsAddModelModalOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointConfig | null>(null);
  const [newEndpointData, setNewEndpointData] = useState<EndpointConfig>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
  const [endpointTestStatus, setEndpointTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [endpointTestMessage, setEndpointTestMessage] = useState('');
  const [endpointModalError, setEndpointModalError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
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
        if (data.historyPageRounds !== undefined) {
          const nextHistoryPageRounds = normalizeChatHistoryPageRounds(data.historyPageRounds);
          setHistoryPageRoundsInput(String(nextHistoryPageRounds));
          persistChatHistoryPageRounds(nextHistoryPageRounds);
        }
        if (data.language) {
          void applyLanguagePreference(data.language);
        }
      })
      .catch(console.error);

    fetchCommands();
    fetchModels();
    fetchGlobalFallbacks();
    fetchEndpoints();

    fetchMaxPermissionsState().catch(console.error);
  }, []);

  const fetchCurrentVersionInfo = async () => {
    setIsLoadingAppVersion(true);
    setAppVersionError(EMPTY_INLINE_ERROR);
    try {
      const res = await fetch('/api/version');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAppVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.currentVersionLoadFailed'));
        setAppVersionInfo(null);
        return null;
      }
      const versionInfo = data as AppVersionInfo;
      setAppVersionInfo(versionInfo);
      setDetectedOpenClawVersion(versionInfo.openclawVersion || '');
      return versionInfo;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setAppVersionError({
        message: t('settings.about.currentVersionLoadFailed'),
        detail,
      });
      setAppVersionInfo(null);
      return null;
    } finally {
      setIsLoadingAppVersion(false);
    }
  };

  const buildUpdateRequestHeaders = (includeJson = false): HeadersInit => {
    const headers: Record<string, string> = {};
    const authToken = localStorage.getItem('clawui_auth_token');
    if (authToken && authToken !== 'disabled') {
      headers['X-ClawUI-Auth-Token'] = authToken;
    }
    if (includeJson) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  };

  const fetchUpdateStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await fetch('/api/update/status', {
        headers: buildUpdateRequestHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.quiet) {
          const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStatusLoadFailed');
          setLatestVersionError(display);
        }
        return null;
      }
      const nextUpdate = data.update as UpdateStatusInfo;
      setUpdateStatusInfo(nextUpdate);
      return nextUpdate;
    } catch (error) {
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setLatestVersionError({
          message: t('settings.about.updateStatusLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const handleCheckLatestVersion = async () => {
    setIsCheckingLatestVersion(true);
    setLatestVersionError(EMPTY_INLINE_ERROR);
    setLatestVersionInfo(null);
    try {
      const res = await fetch('/api/version/latest');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLatestVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.latestVersionLoadFailed'));
        return;
      }
      const latestData = data as LatestVersionInfo;
      setLatestVersionInfo(latestData);
      if (!appVersionInfo) {
        setAppVersionInfo(prev => prev || {
          appName: latestData.appName,
          version: latestData.currentVersion,
          releaseTag: `v${latestData.currentVersion}`,
          commit: null,
          buildTime: null,
          repositoryUrl: latestData.repositoryUrl,
          openclawVersion: null,
        });
      }
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setLatestVersionError({
        message: t('settings.about.latestVersionLoadFailed'),
        detail,
      });
    } finally {
      setIsCheckingLatestVersion(false);
    }
  };

  const handleStartUpdate = async () => {
    try {
      const res = await fetch('/api/update/start', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStartFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setLatestVersionError(EMPTY_INLINE_ERROR);
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateStartFailed'), detail);
    }
  };

  const handleCancelUpdate = async () => {
    setIsCancellingUpdate(true);
    try {
      const res = await fetch('/api/update/cancel', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateCancelFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateCancelFailed'), detail);
      return false;
    } finally {
      setIsCancellingUpdate(false);
    }
  };

  const handleResetUpdateState = async () => {
    try {
      const res = await fetch('/api/update/reset', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateResetFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      setLatestVersionInfo(null);
      setLatestVersionError(EMPTY_INLINE_ERROR);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateResetFailed'), detail);
    }
  };

  const handleRestartUpdatedService = async () => {
    try {
      const res = await fetch('/api/update/restart-service', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.restartServiceFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.restartServiceFailed'), detail);
    }
  };

  const handleLatestVersionAction = () => {
    if (updateStatusInfo?.status === 'checking' || updateStatusInfo?.status === 'stopping' || updateStatusInfo?.status === 'restarting') {
      return;
    }

    if (updateStatusInfo?.status === 'updating') {
      setIsUpdateCancelModalOpen(true);
      return;
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      void handleRestartUpdatedService();
      return;
    }

    if (updateStatusInfo?.status === 'update_failed' || updateStatusInfo?.status === 'restart_failed') {
      void handleResetUpdateState();
      return;
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      void handleStartUpdate();
      return;
    }

    void handleCheckLatestVersion();
  };

  const handleConfirmCancelUpdate = async () => {
    if (!updateStatusInfo?.canCancel || updateStatusInfo.status !== 'updating') {
      return;
    }

    const cancelled = await handleCancelUpdate();
    if (cancelled) {
      setIsUpdateCancelModalOpen(false);
    }
  };

  useEffect(() => {
    if (settingsTab !== 'about' && settingsTab !== 'gateway') return;
    void fetchCurrentVersionInfo();
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'gateway') return;
    void fetchBrowserHeadedModeState();
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    void fetchUpdateStatus({ quiet: true });
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    const activeStatus = updateStatusInfo?.status;
    if (!activeStatus || !['checking', 'updating', 'stopping', 'restarting'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextUpdate = await fetchUpdateStatus({ quiet: activeStatus === 'restarting' });
      if (cancelled || !nextUpdate) return;

      if (activeStatus === 'restarting' && nextUpdate.status === 'idle') {
        await fetchCurrentVersionInfo();
        await handleCheckLatestVersion();
      }

      if ((activeStatus === 'stopping' || activeStatus === 'updating') && nextUpdate.status === 'idle') {
        setLatestVersionInfo(null);
        setLatestVersionError(EMPTY_INLINE_ERROR);
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, updateStatusInfo?.status]);

  useEffect(() => {
    if (updateStatusInfo?.status !== 'updating') {
      setIsUpdateCancelModalOpen(false);
      setIsCancellingUpdate(false);
    }
  }, [updateStatusInfo?.status]);

  const fetchModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success) {
        const nextModels = data.models || [];
        const nextDefaultModelId = nextModels.find((model: { id: string; primary: boolean }) => model.primary)?.id || '';
        setModels(nextModels);
        setDefaultModelId(nextDefaultModelId);
        onModelsChanged?.();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchGlobalFallbacks = async () => {
    try {
      const res = await fetch('/api/models/fallbacks');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        setGlobalFallbackError(EMPTY_INLINE_ERROR);
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
      } else {
        setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
      }
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
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

  const handleSaveGlobalFallbacks = async () => {
    setIsSavingGlobalFallbacks(true);
    setGlobalFallbackError(EMPTY_INLINE_ERROR);

    try {
      const res = await fetch('/api/models/fallbacks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fallbacks: globalFallbackMode === 'disabled' ? [] : globalFallbacks,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
        return;
      }

      setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackSaveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingGlobalFallbacks(false);
    }
  };

  useEffect(() => {
    if (suppressGlobalFallbackAutosaveRef.current) return;
    if (globalFallbackMode === 'custom' && globalFallbacks.length === 0) return;

    if (globalFallbackAutosaveTimerRef.current !== null) {
      window.clearTimeout(globalFallbackAutosaveTimerRef.current);
    }

    globalFallbackAutosaveTimerRef.current = window.setTimeout(() => {
      void handleSaveGlobalFallbacks();
      globalFallbackAutosaveTimerRef.current = null;
    }, 180);

    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
        globalFallbackAutosaveTimerRef.current = null;
      }
    };
  }, [globalFallbackMode, globalFallbacks]);

  useEffect(() => {
    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
      }
      if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
      }
    };
  }, []);

  // Capability definitions
  const CAPABILITIES = [
    { id: 'image',     label: t('settings.models.capability.image'), Icon: Eye,         color: 'text-violet-600 bg-violet-50 border-violet-200' },
    { id: 'reasoning', label: t('settings.models.capability.reasoning'), Icon: Zap,         color: 'text-amber-600 bg-amber-50 border-amber-200' },
    { id: 'tools',     label: t('settings.models.capability.tools'), Icon: Wrench,      color: 'text-pink-600 bg-pink-50 border-pink-200' },
    { id: 'web',       label: t('settings.models.capability.web'), Icon: Globe,       color: 'text-blue-600 bg-blue-50 border-blue-200' },
    { id: 'rerank',    label: t('settings.models.capability.rerank'), Icon: ArrowUpDown, color: 'text-gray-600 bg-gray-50 border-gray-200' },
    { id: 'embed',     label: t('settings.models.capability.embed'), Icon: Link2,       color: 'text-gray-600 bg-gray-50 border-gray-200' },
  ] as const;

  const guessCapabilities = (modelId: string): string[] => {
    const id = modelId.toLowerCase();
    const caps = new Set<string>(['text']);
    if (/vision|4v|claude-3|claude-opus|claude-sonnet|claude-haiku|gpt-4o|gpt-4-turbo|gemini|llava|qwen.*vl|intern.*vl|glm-4v|minicpm.*v|cogvlm|pixtral|phi.*vision|qvq|kimi.*vl|chatglm.*vl/.test(id)) caps.add('image');
    if (/o1|o3|o4|thinking|reasoning|deepthink|r1|r2/.test(id)) caps.add('reasoning');
    if (/embed|embedding|text-embedding|bge|e5-/.test(id)) caps.add('embed');
    if (/rerank|reranker|bce-reranker/.test(id)) caps.add('rerank');
    return Array.from(caps);
  };

  const handleDiscoverModels = async (endpointId: string) => {
    if (!endpointId) return;
    
    // Abort any ongoing fetch
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    discoverAbortControllerRef.current = controller;

    setIsDiscovering(true);
    setHasFetched(false);
    setDiscoveredModels([]);
    setModelSearchQuery('');
    setIndividualTestStatus({});
    setIsModelDropdownOpen(false); // keep closed until results are back
    setAddModelError('');
    setAddModelErrorDetail('');

    try {
      const res = await fetch(`/api/models/discover?endpoint=${encodeURIComponent(endpointId)}`, {
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setDiscoveredModels(data.models || []);
        setHasFetched(true);
        if ((data.models || []).length > 0) {
          setIsModelDropdownOpen(true);
        }
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.discoverFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Discovery aborted');
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        setAddModelError(t('settings.models.discoverFailed'));
        setAddModelErrorDetail(detail);
      }
    } finally {
      if (discoverAbortControllerRef.current === controller) {
        setIsDiscovering(false);
        discoverAbortControllerRef.current = null;
      }
    }
  };

  const cancelDiscovery = () => {
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
      discoverAbortControllerRef.current = null;
      setIsDiscovering(false);
    }
  };

  const handleTestSingleModel = async (modelId: string, e?: React.MouseEvent, signal?: AbortSignal) => {
    if (e) e.stopPropagation();
    setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'testing', message: '' }}));
    try {
      const res = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: newModelEndpoint.trim(), modelName: modelId }),
        signal
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'success', message: 'OK' }}));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.connectivityFailed');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message: display.message, detail: display.detail || undefined }}));
        if (!signal && display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Just clear the testing state if aborted, don't show an error
        setIndividualTestStatus(prev => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        const message = t('settings.models.testNetworkError');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message, detail: detail || undefined }}));
        if (!signal && detail) {
          openSettingsErrorModal(message, detail);
        }
      }
    }
  };

  const handleTestExistingSingleModel = async (fullModelId: string, endpoint: string, modelName: string) => {
    setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'testing' } }));
    try {
      const res = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, modelName })
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'success' } }));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.connectivityFailed');
        setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message: display.message, detail: display.detail || undefined } }));
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message, detail: detail || undefined } }));
      if (detail) {
        openSettingsErrorModal(message, detail);
      }
    }
  };

  const existingModelIds = new Set(models.map(m => m.id));

  const handleTestAllFiltered = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    testAllAbortControllerRef.current = controller;

    const filtered = discoveredModels.filter(m => m.toLowerCase().includes(modelSearchQuery.toLowerCase()));
    const testPromises = filtered.map(async (m) => {
      if (existingModelIds.has(`${newModelEndpoint.trim()}/${m}`)) return;
      await handleTestSingleModel(m, undefined, controller.signal);
    });

    try {
      await Promise.all(testPromises);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setAddModelError(error.message || t('settings.models.partialBatchTestFailed'));
        setAddModelErrorDetail('');
      }
    } finally {
      if (testAllAbortControllerRef.current === controller) {
        testAllAbortControllerRef.current = null;
      }
    }
  };

  const cancelTestAll = () => {
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
      testAllAbortControllerRef.current = null;
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    setGatewayError(false);
    if (!url.trim()) {
      setGatewayErrorMessage(t('settings.gateway.gatewayUrlRequired'));
      setGatewayErrorDetail('');
      setGatewayErrorModalOpen(true);
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
      } else throw new Error(t('settings.gateway.saveFailed'));
    } catch (err) {
      setGatewayError(true);
      setTimeout(() => setGatewayError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDetectAll = async () => {
    setIsDetectingAll(true);
    setDetectError('');
    setDetectedOpenClawVersion('');
    try {
      const res = await fetch('/api/config/detect-all');
      const data = await res.json();
      if (data.success && data.data) {
        if (data.data.gatewayUrl) setUrl(data.data.gatewayUrl);
        if (data.data.token) setToken(data.data.token);
        if (data.data.password) setPassword(data.data.password);
        if (data.data.workspacePath) setOpenclawWorkspace(data.data.workspacePath);
        setDetectedOpenClawVersion(typeof data.data.openclawVersion === 'string' ? data.data.openclawVersion : '');
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.detectFailed');
        setDetectError(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err) {
      console.error(err);
      setDetectError(t('settings.gateway.detectNetworkError'));
    } finally {
      setIsDetectingAll(false);
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
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.restartFailed');
        setGatewayErrorMessage(display.message);
        setGatewayErrorDetail(display.detail);
        setGatewayErrorModalOpen(true);
      }
    } catch (err) {
      console.error(err);
      setGatewayErrorMessage(t('settings.gateway.restartNetworkError'));
      setGatewayErrorDetail('');
      setGatewayErrorModalOpen(true);
    } finally {
      setIsRestarting(false);
    }
  };

  const applyBrowserHealthSnapshot = (snapshot: BrowserHealthSnapshot) => {
    setBrowserHealth(snapshot);
    if (typeof snapshot.maxPermissionsEnabled === 'boolean') {
      setMaxPermissions(snapshot.maxPermissionsEnabled);
    }
    if (typeof snapshot.config?.headless === 'boolean') {
      setBrowserHeadedModeEnabled(snapshot.config.headless !== true);
    }
  };

  const applyBrowserHeadedModeConfig = (config: BrowserHeadedModeConfig) => {
    setBrowserHeadedModeEnabled(config.headedModeEnabled);
    setBrowserHealth(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        config: {
          enabled: prev.config?.enabled ?? prev.enabled,
          headless: config.headless,
          profile: prev.config?.profile ?? prev.profile,
          executablePath: prev.config?.executablePath ?? null,
          noSandbox: prev.config?.noSandbox ?? null,
          attachOnly: prev.config?.attachOnly ?? null,
          cdpPort: prev.config?.cdpPort ?? null,
        },
      };
    });
  };

  const fetchBrowserHeadedModeState = async () => {
    setIsLoadingBrowserHeadedMode(true);
    try {
      const res = await fetch('/api/config/browser-headed-mode');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeLoadFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoadingBrowserHeadedMode(false);
    }
  };

  const fetchMaxPermissionsState = async () => {
    const res = await fetch('/api/config/max-permissions');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.message === 'string' ? data.message : 'Failed to load max permissions state');
    }
    const enabled = !!data.enabled;
    setMaxPermissions(enabled);
    return enabled;
  };

  const handleToggleMaxPermissions = async () => {
    const nextEnabled = !maxPermissions;
    setMaxPermissions(nextEnabled);
    setIsTogglingPermissions(true);
    setBrowserHealthNotice(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    try {
      const res = await fetch('/api/config/max-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setMaxPermissions(!!data.enabled);
        setBrowserHealth(null);
      } else {
        await fetchMaxPermissionsState().catch(() => {
          setMaxPermissions(!nextEnabled);
        });
      }
    } catch (err) {
      console.error(err);
      await fetchMaxPermissionsState().catch(() => {
        setMaxPermissions(!nextEnabled);
      });
    } finally {
      setIsTogglingPermissions(false);
    }
  };

  const handleCheckBrowserHealth = async () => {
    setIsCheckingBrowserHealth(true);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await fetch('/api/config/browser-health');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.health) {
        applyBrowserHealthSnapshot(data.health as BrowserHealthSnapshot);
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHealthFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHealthFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsCheckingBrowserHealth(false);
    }
  };

  const handleToggleBrowserHeadedMode = async () => {
    if (browserHeadedModeEnabled === null) return;

    const nextHeadedModeEnabled = !browserHeadedModeEnabled;
    setBrowserHeadedModeEnabled(nextHeadedModeEnabled);
    setIsTogglingBrowserHeadedMode(true);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);

    try {
      const res = await fetch('/api/config/browser-headed-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headedModeEnabled: nextHeadedModeEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
        setBrowserHealth(null);
      } else {
        await fetchBrowserHeadedModeState();
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeUpdateFailed'));
      }
    } catch (err) {
      await fetchBrowserHeadedModeState();
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeUpdateFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsTogglingBrowserHeadedMode(false);
    }
  };

  const handleSelfHealBrowser = async () => {
    setIsSelfHealingBrowser(true);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await fetch('/api/config/browser-health/self-heal', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.after) {
        const nextSnapshot = data.after as BrowserHealthSnapshot;
        applyBrowserHealthSnapshot(nextSnapshot);
        setBrowserHealthNotice({
          tone: nextSnapshot.healthy ? 'success' : 'warning',
          message: nextSnapshot.healthy
            ? t('settings.gateway.browserSelfHealSuccess')
            : t('settings.gateway.browserSelfHealNeedsAttention'),
        });
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserSelfHealFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserSelfHealFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSelfHealingBrowser(false);
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
    if (!editHostValue.trim() || !editingHost) return;
    const updated = allowedHosts.map(h => h === editingHost ? editHostValue.trim() : h);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedHosts: updated }),
      });
      if (res.ok) {
        setAllowedHosts(updated);
        setEditingHost(null);
        setEditHostValue('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startEditHost = (host: string) => {
    setEditingHost(host);
    setEditHostValue(host);
  };

  const handleRemoveHost = (hostToRemove: string) => {
    setDeleteTarget({ type: 'host', value: hostToRemove });
    setDeleteModalMessage(t('settings.gateway.removeHostConfirm', { host: hostToRemove }));
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
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setGatewayErrorModalOpen(false);
        setGatewayErrorMessage('');
        setGatewayErrorDetail('');
        setTestResult({ success: true, message: data.message || '' });
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.testFailed');
        setTestResult({ success: false, message: display.message });
        openSettingsErrorModal(display.message, display.detail);
      }
    } catch (err) {
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.gateway.testFailed');
      setTestResult({ success: false, message });
      openSettingsErrorModal(message, detail);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveGeneral = async () => {
    setIsLoading(true);
    setGeneralError(false);
    const nextHistoryPageRounds = commitHistoryPageRounds();
    if (!aiName.trim()) {
      setAiNameError('required');
      setIsLoading(false);
      return;
    }
    if (getVisualLength(aiName) > 20) {
      setAiNameError('tooLong');
      setIsLoading(false);
      return;
    }
    setAiNameError('');

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiName, loginEnabled, loginPassword, historyPageRounds: nextHistoryPageRounds }),
      });
      if (res.ok) {
        setGeneralSaved(true);
        setTimeout(() => setGeneralSaved(false), 2000);
      } else throw new Error(t('settings.general.saveError'));
    } catch (err) {
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLanguageChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = normalizeLanguage(event.target.value) as SupportedLanguage;

    if (normalizeLanguage(i18n.resolvedLanguage || i18n.language) === nextLanguage) {
      return;
    }

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: nextLanguage }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(
          (typeof data?.error === 'string' && data.error.trim()) ||
          (typeof data?.message === 'string' && data.message.trim()) ||
          'Failed to persist preferred language'
        );
      }

      await applyLanguagePreference(nextLanguage);
    } catch (error) {
      console.error('Failed to update language preference:', error);
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    }
  };

  const commitHistoryPageRounds = () => {
    const nextValue = persistChatHistoryPageRounds(historyPageRoundsInput);
    setHistoryPageRoundsInput(String(nextValue));
    return nextValue;
  };

  const handleHistoryPageRoundsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/[^\d]/g, '');
    setHistoryPageRoundsInput(digitsOnly);
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
    setDeleteModalMessage(t('settings.commands.deleteConfirm'));
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
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchGlobalFallbacks();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteModelFailed'));
        }
      } else if (deleteTarget.type === 'endpoint') {
        const res = await fetch('/api/endpoints/manage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: deleteTarget.name }),
        });
        if (res.ok) {
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchGlobalFallbacks();
          fetchEndpoints();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteEndpointFailed'));
        }
      }
    } catch (err) {
      console.error(err);
      if (deleteTarget.type === 'model') {
        setModelActionError({
          message: t('settings.models.deleteModelFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      } else if (deleteTarget.type === 'endpoint') {
        setModelActionError({
          message: t('settings.models.deleteEndpointFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      }
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

  const handleTestModel = async (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequiredForTest'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
      return false;
    }
    setAddModelTestStatus('testing');
    setAddModelTestMessage(t('settings.models.testingConnectivity'));
    try {
      const res = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim()
        })
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setAddModelTestStatus('success');
        const latency = data.latency !== undefined ? `${data.latency}ms` : t('settings.models.unknownLatency');
        setAddModelTestMessage(t('settings.models.connectivityGood', { latency }));
        return true;
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.connectivityFailed');
        setAddModelTestStatus('error');
        setAddModelTestMessage(display.message);
        setTestModelMessage(display.detail || display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
        return false;
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setAddModelTestStatus('error');
      setAddModelTestMessage(message);
      setTestModelMessage(detail || message);
      if (detail) {
        openSettingsErrorModal(message, detail);
      }
      return false;
    }
  };

  const handleAddModel = async () => {
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequired'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
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
          alias: newModelAlias.trim() || undefined,
          input: newModelInput.length > 0 ? newModelInput : undefined,
        }),
      });
      
      if (res.ok) {
        setNewModelEndpoint('');
        setNewModelName('');
        setNewModelAlias('');
        setNewModelInput(['text']);
        setAddModelError('');
        setAddModelErrorDetail('');
        setIsAddModelModalOpen(false);
        fetchModels();
      } else {
        const data = await res.json().catch(() => ({}));
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.saveModelFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err) {
      console.error(err);
      setAddModelError(t('settings.models.addModelNetworkError'));
      setAddModelErrorDetail(err instanceof Error && err.message.trim() ? err.message.trim() : '');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteModel = (id: string, isPrimary: boolean) => {
    setDeleteTarget({ type: 'model', id });
    setDeleteModalMessage(t('settings.models.deleteModelConfirm', {
      id,
      defaultWarning: isPrimary ? t('settings.models.defaultModelWarning') : '',
    }));
    setIsDeleteModalOpen(true);
  };

  const handleSaveDefaultModelSelection = async (id: string) => {
    const nextId = id.trim();
    if (!nextId) {
      setDefaultModelError({
        message: t('settings.models.defaultModelNoSelection'),
        detail: '',
      });
      return;
    }

    const previousId = defaultModelId;
    setDefaultModelId(nextId);
    setDefaultModelError(EMPTY_INLINE_ERROR);
    setIsSavingDefaultModel(true);

    try {
      const res = await fetch('/api/models/manage/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: nextId }),
      });

      if (res.ok) {
        await fetchModels();
        return;
      }

      const data = await res.json().catch(() => ({}));
      setDefaultModelId(previousId);
      setDefaultModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.setDefaultModelFailed'));
    } catch (err) {
      setDefaultModelId(previousId);
      setDefaultModelError({
        message: t('settings.models.setDefaultModelNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingDefaultModel(false);
    }
  };

  const handleSetDefaultModel = async (id: string) => {
    setIsLoading(true);
    try {
      await handleSaveDefaultModelSelection(id);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const startEditModel = (model: { id: string; alias?: string; input: string[] }) => {
    setEditingModelId(model.id);
    setEditingAlias(model.alias || '');
    setEditingInput(model.input || []);
    setTimeout(() => editAliasInputRef.current?.focus(), 50);
  };

  const handleDeleteEndpoint = (endpoint: string, count: number) => {
    setDeleteTarget({ type: 'endpoint', name: endpoint });
    setDeleteModalMessage(t('settings.models.deleteEndpointConfirm', { endpoint, count }));
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
        body: JSON.stringify({ id: editingModelId, alias: editingAlias, input: editingInput }),
      });
      if (res.ok) {
        setModelActionError(EMPTY_INLINE_ERROR);
        setEditingModelId(null);
        setEditingAlias('');
        setEditingInput([]);
        fetchModels();

      } else {
        const data = await res.json().catch(() => ({}));
        setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.editAliasFailed'));
      }
    } catch (err) {
      console.error(err);
      setModelActionError({
        message: t('settings.models.editAliasNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const openAddEndpointModal = () => {
    setEditingEndpoint(null);
    setNewEndpointData({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const openEditEndpointModal = (ep: EndpointConfig) => {
    setEditingEndpoint(ep);
    setNewEndpointData({ ...ep });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const handleSaveEndpoint = async () => {
    if (!newEndpointData.id.trim() || !newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointModalError({ message: t('settings.models.endpointConfigRequired'), detail: '' });
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
        setEndpointModalError(EMPTY_INLINE_ERROR);
        setIsEndpointModalOpen(false);
        fetchEndpoints();

      } else {
        const data = await res.json().catch(() => ({}));
        setEndpointModalError(resolveStructuredErrorDisplay(data, t, 'settings.models.saveEndpointFailed'));
      }
    } catch (err) {
      console.error(err);
      setEndpointModalError({
        message: t('settings.models.saveEndpointNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestEndpoint = async () => {
    if (!newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.fillBaseUrlApiType'));
      return;
    }
    
    setEndpointTestStatus('testing');
    setEndpointTestMessage(t('settings.models.testing'));
    
    try {
      const res = await fetch('/api/endpoints/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: newEndpointData.baseUrl,
          apiKey: newEndpointData.apiKey,
          api: newEndpointData.api
        })
      });
      const data = await res.json();
      if (data.success) {
        setEndpointTestStatus('success');
        setEndpointTestMessage(t('settings.models.endpointConnectionSuccess'));
        setTimeout(() => setEndpointTestStatus('idle'), 3000);
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.endpointConnectionFailed');
        setEndpointTestStatus('error');
        setEndpointTestMessage(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.networkConnectionError'));
      if (detail) {
        openSettingsErrorModal(t('settings.models.networkConnectionError'), detail);
      }
    }
  };

  // Get distinct endpoints from current models, merged with actual endpoints objects
  const knownEndpoints = Array.from(new Set([
    ...endpoints.map(ep => ep.id),
    ...models.map(m => m.id.split('/')[0]).filter(Boolean)
  ])).sort((a, b) => a.localeCompare(b));
  const currentPrimaryModelId = models.find((model) => model.primary)?.id || '';

  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  const effectiveLatestVersion = updateStatusInfo?.latestVersion || latestVersionInfo?.latestVersion || null;
  const updatePhaseVisual = updateStatusInfo?.phase && UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    ? UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    : { progress: 8, labelKey: 'settings.about.updateProgressPreparing' };
  const updateFailureDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const updateCheckDetail = joinDistinctLines([
    latestVersionError.detail,
    latestVersionError.message,
  ]);
  const updateProgressVisual = (() => {
    const baseProgress = updatePhaseVisual.progress;
    const clickableIdle = !isCheckingLatestVersion;

    if (updateStatusInfo?.status === 'checking') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'updating') {
      return {
        progress: Math.max(baseProgress, 10),
        label: `${t(updatePhaseVisual.labelKey)}${t('settings.about.updateProgressClickToStopSuffix')}`,
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'stopping') {
      return {
        progress: Math.max(baseProgress, 15),
        label: t('settings.about.updateProgressStopping'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      return {
        progress: 100,
        label: t('settings.about.updateSucceededButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_failed') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'restarting') {
      return {
        progress: 100,
        label: t('settings.about.restartingButton'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'restart_failed') {
      return {
        progress: 100,
        label: t('settings.about.restartFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      return {
        progress: 0,
        label: t('settings.about.checkUpdateAvailableButton', {
          version: effectiveLatestVersion || t('settings.about.unavailable'),
        }),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (isCheckingLatestVersion) {
      return {
        progress: 12,
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (latestVersionInfo?.status === 'up_to_date') {
      return {
        progress: 100,
        label: t('settings.about.checkUpToDateButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (latestVersionInfo?.status === 'no_release') {
      return {
        progress: 0,
        label: t('settings.about.checkNoReleaseButton'),
        detail: '',
        tone: 'neutral' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (latestVersionError.message) {
      return {
        progress: 0,
        label: t('settings.about.checkRetryButton'),
        detail: updateCheckDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    return {
      progress: 0,
      label: t('settings.about.checkNewVersion'),
      detail: '',
      tone: 'neutral' as UpdateProgressTone,
      layout: 'compact' as UpdateProgressLayout,
      clickable: clickableIdle,
      showSpinner: false,
      icon: 'activity' as const,
    };
  })();
  const updateProgressToneClasses = updateProgressVisual.tone === 'success'
    ? {
      container: 'border-emerald-200 bg-emerald-50',
      hover: 'hover:bg-emerald-100',
      text: 'text-emerald-700',
      icon: 'text-emerald-600',
      fill: 'bg-emerald-200/90',
      detail: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    }
    : updateProgressVisual.tone === 'error'
      ? {
        container: 'border-red-200 bg-red-50',
        hover: 'hover:bg-red-100',
        text: 'text-red-700',
        icon: 'text-red-600',
        fill: 'bg-red-200/90',
        detail: 'border-red-200 bg-red-50 text-red-700',
      }
      : updateProgressVisual.tone === 'brand'
        ? {
          container: 'border-blue-200 bg-blue-50',
          hover: 'hover:bg-blue-100',
          text: 'text-[#2563eb]',
          icon: 'text-[#2563eb]',
          fill: 'bg-blue-200/90',
          detail: 'border-blue-200 bg-blue-50 text-[#2563eb]',
        }
        : {
          container: 'border-blue-200 bg-blue-50',
          hover: 'hover:bg-blue-100',
          text: 'text-[#2563eb]',
          icon: 'text-[#2563eb]',
          fill: 'bg-blue-200/90',
          detail: 'border-blue-200 bg-blue-50 text-[#2563eb]',
        };
  const updateProgressTitle = updateProgressVisual.detail || updateFailureDetail || updateCheckDetail || undefined;
  const updateProgressWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:w-[24rem]'
    : 'w-full sm:w-auto';
  const updateProgressButtonWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:min-w-[24rem]'
    : 'w-full sm:w-auto';
  const updateCancelUnsafeDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const updateCancelModalTitle = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmTitle')
    : t('settings.about.updateCancelUnavailableTitle');
  const updateCancelModalMessage = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmMessage')
    : t('settings.about.updateCancelUnavailableMessage');
  const secondaryActionButtonClass = 'inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold leading-5 text-[#2563eb] text-center transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60';
  const browserHealthNotCheckedText = t('settings.gateway.browserHealthStates.notChecked');
  const browserHealthValueFallback = browserHealth ? t('common.unknown') : browserHealthNotCheckedText;
  const browserHealthConfig = browserHealth?.config ?? null;
  const browserHealthRuntime = browserHealth?.runtime ?? null;
  const browserHealthFacts = [
    {
      label: t('settings.gateway.browserHealthPermissionsLabel'),
      value: browserHealth?.maxPermissionsEnabled === null || !browserHealth
        ? browserHealthValueFallback
        : browserHealth.maxPermissionsEnabled
          ? t('settings.gateway.browserHealthStates.permissionsEnabled')
          : t('settings.gateway.browserHealthStates.permissionsDisabled'),
    },
    {
      label: t('settings.gateway.browserHealthEnabledLabel'),
      value: browserHealthConfig?.enabled === null || browserHealthConfig?.enabled === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthConfig.enabled
          ? t('settings.gateway.browserHealthStates.enabled')
          : t('settings.gateway.browserHealthStates.disabled'),
    },
    {
      label: t('settings.gateway.browserHealthRunningLabel'),
      value: browserHealthRuntime?.running === null || browserHealthRuntime?.running === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.running
          ? t('settings.gateway.browserHealthStates.running')
          : t('settings.gateway.browserHealthStates.stopped'),
    },
    {
      label: t('settings.gateway.browserHealthTransportLabel'),
      value: browserHealthRuntime?.transport || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthModeLabel'),
      value: browserHealthRuntime?.headless === null || browserHealthRuntime?.headless === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.headless
          ? t('settings.gateway.browserHealthStates.headless')
          : t('settings.gateway.browserHealthStates.windowed'),
    },
    {
      label: t('settings.gateway.browserHealthBrowserLabel'),
      value: browserHealthRuntime?.detectedBrowser || browserHealthRuntime?.chosenBrowser || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthProfileLabel'),
      value: browserHealthRuntime?.profile || browserHealthConfig?.profile || browserHealth?.profile || browserHealthValueFallback,
    },
  ];
  const browserHealthDetail = browserHealth?.validationDetail || browserHealth?.rawDetail || browserHealthRuntime?.detectError || browserHealth?.detectError || browserHealthError.detail || browserHealthError.message || '';
  const browserHealthDetailText = browserHealthDetail
    || (browserHealthError.message
      ? t('settings.gateway.browserHealthButtonNeedsAttention')
      : browserHealth
        ? browserHealth.healthy
          ? t('settings.gateway.browserHealthButtonHealthy')
          : t('settings.gateway.browserHealthButtonNeedsAttention')
        : browserHealthNotCheckedText);
  const headerTitle = settingsTab === 'gateway'
    ? t('settings.gateway.headerTitle')
    : settingsTab === 'general'
      ? t('settings.general.headerTitle')
      : settingsTab === 'commands'
        ? t('settings.commands.headerTitle')
        : settingsTab === 'models'
          ? t('settings.models.headerTitle')
          : t('settings.about.headerTitle');

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      <header className="h-14 flex items-center px-4 sm:px-8 border-b border-gray-200 bg-white sticky top-0 z-10 gap-3">
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
                <div className="flex items-center justify-between mb-1">
                  <div className="flex min-w-0 items-baseline gap-3">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {t('settings.gateway.connectionTitle')}
                    </h3>
                    {detectedOpenClawVersion && (
                      <span className="text-sm font-normal text-gray-500">
                        {t('settings.gateway.versionInline', { version: detectedOpenClawVersion })}
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <div className="flex flex-wrap items-center justify-end">
                      <button
                        type="button"
                        onClick={handleDetectAll}
                        disabled={isDetectingAll || isLoading}
                        className={`${secondaryActionButtonClass} shrink-0`}
                      >
                        {isDetectingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                        {t('settings.gateway.autoDetect')}
                      </button>
                    </div>
                    {detectError && (
                      <div className="absolute top-full mt-2 right-0 w-80 text-xs bg-red-50 text-red-600 border border-red-200 p-2 rounded-lg z-10 break-words pointer-events-none">
                        {detectError}
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-sm text-gray-500 mb-6 mt-1">{t('settings.gateway.description')}</p>
                
                <div className="space-y-5 sm:space-y-6 bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      {t('settings.gateway.gatewayUrlLabel')} <span className="text-red-500">*</span>
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
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.tokenLabel')}</label>
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.passwordLabel')}</label>
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
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      {t('settings.gateway.workspaceLabel')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={openclawWorkspace}
                        onChange={(e) => setOpenclawWorkspace(e.target.value)}
                        placeholder="/root/.openclaw/workspace-main"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-1.5">
                      {t('settings.gateway.workspaceHint')}
                    </p>
                  </div>
                </div>

                {/* Max Permissions Toggle */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.permissionsTitle')}</h3>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.permissionsDescription')}</p>

                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 pr-4">
                        <div className="text-sm font-semibold text-gray-900">{t('settings.gateway.maxPermissionsLabel')}</div>
                        <p className="text-xs text-gray-400 mt-1">
                          {t('settings.gateway.maxPermissionsHint')}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={maxPermissions}
                        disabled={isTogglingPermissions}
                        onClick={handleToggleMaxPermissions}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed ${ maxPermissions ? 'bg-blue-600' : 'bg-gray-200' }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${ maxPermissions ? 'translate-x-6' : 'translate-x-1' }`}
                        />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-8">
                  <div className="mb-1 flex items-center justify-between gap-4">
                    <h3 className="text-lg font-semibold text-gray-900">{t('settings.gateway.browserHealthTitle')}</h3>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-sm font-medium text-gray-600 whitespace-nowrap">
                        {t('settings.gateway.browserHeadedModeLabel')}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={browserHeadedModeEnabled === true}
                        aria-label={t('settings.gateway.browserHeadedModeLabel')}
                        disabled={isLoadingBrowserHeadedMode || isTogglingBrowserHeadedMode || isLoading}
                        onClick={handleToggleBrowserHeadedMode}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60 ${browserHeadedModeEnabled ? 'bg-blue-600' : 'bg-gray-200'}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${browserHeadedModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                        />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.browserHealthDescription')}</p>

                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
                    <div className="space-y-3">
                      <div className="flex gap-2 flex-nowrap">
                        <button
                          type="button"
                          onClick={handleCheckBrowserHealth}
                          disabled={isCheckingBrowserHealth || isSelfHealingBrowser || isLoading}
                          className={`${secondaryActionButtonClass} flex-1 min-w-0`}
                        >
                          {isCheckingBrowserHealth ? <Loader2 className="hidden sm:block w-4 h-4 animate-spin shrink-0" /> : <Activity className="hidden sm:block w-4 h-4 shrink-0" />}
                          <span className="min-w-0 text-center leading-snug">
                            {isCheckingBrowserHealth
                              ? t('settings.gateway.checkingBrowserHealth')
                              : t('settings.gateway.checkBrowserHealth')}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={handleSelfHealBrowser}
                          disabled={isCheckingBrowserHealth || isSelfHealingBrowser || isLoading}
                          className={`${secondaryActionButtonClass} flex-1 min-w-0`}
                        >
                          {isSelfHealingBrowser ? <Loader2 className="hidden sm:block w-4 h-4 animate-spin shrink-0" /> : <Wrench className="hidden sm:block w-4 h-4 shrink-0" />}
                          <span className="min-w-0 text-center leading-snug">
                            {isSelfHealingBrowser ? t('settings.gateway.selfHealingBrowser') : t('settings.gateway.selfHealBrowser')}
                          </span>
                        </button>
                      </div>

                      <p className="text-sm text-gray-500 whitespace-pre-wrap break-all">
                        <span className="font-medium text-gray-600">{t('settings.gateway.browserHealthDetailLabel')}:</span>{' '}
                        <span>{browserHealthDetailText}</span>
                      </p>
                    </div>

                    {browserHealthNotice && (
                      <div className={`p-3 rounded-xl border text-sm ${browserHealthNotice.tone === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {browserHealthNotice.message}
                      </div>
                    )}

                    {browserHealthError.message && (
                      <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                        <X className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div>{browserHealthError.message}</div>
                          {browserHealthError.detail && (
                            <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                              {browserHealthError.detail}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {browserHealthFacts.map((item) => (
                        <div key={item.label} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{item.label}</div>
                          <div className="mt-1 text-sm text-gray-700 break-all">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Domain Management Section */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.domainManagementTitle')}</h3>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.domainManagementDescription')}</p>
                  
                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
                    <div className="flex flex-row gap-3">
                      <input
                        type="text"
                        value={newHost}
                        onChange={(e) => setNewHost(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddHost()}
                        placeholder={t('settings.gateway.hostPlaceholder')}
                        className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                      <button
                        onClick={handleAddHost}
                        disabled={!newHost.trim()}
                        className="px-6 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        <span className="hidden sm:inline">{t('common.add')}</span>
                      </button>
                    </div>

                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                       {allowedHosts.map(host => (
                         <div key={host} className="flex w-full items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100 group">
                           {editingHost === host ? (
                             <>
                               <input
                                 type="text"
                                 value={editHostValue}
                                 onChange={(e) => setEditHostValue(e.target.value)}
                                 onKeyDown={(e) => e.key === 'Enter' && handleUpdateHost()}
                                 autoFocus
                                 className="min-w-0 flex-1 w-full text-sm font-mono text-gray-700 bg-transparent outline-none border-none p-0"
                               />
                               <div className="flex items-center gap-1 shrink-0">
                                 <button
                                   onClick={handleUpdateHost}
                                   disabled={!editHostValue.trim()}
                                   className="p-1 px-2 text-green-600 hover:bg-green-50 rounded-lg transition-all disabled:opacity-50"
                                   title={t('common.save')}
                                 >
                                   <Check className="w-4 h-4" />
                                 </button>
                                 <button
                                   onClick={() => { setEditingHost(null); setEditHostValue(''); }}
                                   className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                   title={t('common.cancel')}
                                 >
                                   <X className="w-4 h-4" />
                                 </button>
                               </div>
                             </>
                           ) : (
                             <>
                               <span className="min-w-0 flex-1 text-sm font-mono text-gray-700 break-all">{host}</span>
                               <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-all">
                                 <button
                                   onClick={() => startEditHost(host)}
                                   className="p-1 px-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                                   title={t('common.edit')}
                                 >
                                   <Edit2 className="w-4 h-4" />
                                 </button>
                                 <button
                                   onClick={() => handleRemoveHost(host)}
                                   className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                   title={t('common.delete')}
                                 >
                                   <Trash2 className="w-4 h-4" />
                                 </button>
                               </div>
                             </>
                           )}
                         </div>
                       ))}
                       {allowedHosts.length === 0 && (
                         <div className="text-center py-6 text-gray-400 text-sm italic">
                           {t('settings.gateway.noHosts')}
                         </div>
                       )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-row items-center justify-between pt-4 gap-2 sm:gap-0">
                  <button
                    onClick={handleTest}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 border border-gray-200 text-sm font-medium rounded-xl text-gray-700 bg-white hover:bg-gray-50 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {testResult?.success ? <Check className="w-4 h-4 text-green-600" /> : testResult && !testResult.success ? <X className="w-4 h-4 text-red-500" /> : null}
                    <span className={testResult?.success ? 'text-green-600 font-semibold' : testResult && !testResult.success ? 'text-red-500 font-semibold' : ''}>
                      {isLoading ? '' : testResult?.success ? t('settings.gateway.connectionSuccess') : testResult && !testResult.success ? (testResult.message || t('settings.gateway.connectionFailed')) : <><span className="sm:hidden">{t('common.test')}</span><span className="hidden sm:inline">{t('settings.gateway.testConnection')}</span></>}
                    </span>
                  </button>

                <div className="flex gap-2 sm:gap-3 items-center">
                  <button
                    onClick={handleRestartGateway}
                    disabled={!testResult?.success || isRestarting}
                    className={`inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 text-sm font-medium rounded-xl transition-all ${ testResult?.success ? 'text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200' : 'text-gray-400 bg-gray-100 border border-gray-200 cursor-not-allowed' }`}
                  >
                    {isRestarting ? <Loader2 className="w-4 h-4 animate-spin sm:block hidden" /> : <Loader2 className="w-4 h-4 sm:block hidden" />}
                    {restartSuccess ? t('settings.gateway.restarted') : <><span className="sm:hidden">{t('common.restart')}</span><span className="hidden sm:inline">{t('settings.gateway.restartGateway')}</span></>}
                  </button>

                  <div className="h-6 w-px bg-gray-200 hidden sm:block"></div>
                  {gatewayError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> {t('settings.gateway.saveError')}
                    </span>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={isLoading || !testResult?.success}
                    className={`inline-flex items-center gap-2 px-5 sm:px-8 py-2.5 text-sm font-medium rounded-xl text-white transition-all ${ isLoading || !testResult?.success ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700' }`}
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : gatewaySaved ? <><Check className="w-4 h-4" /> {t('settings.gateway.saved')}</> : <><span className="sm:hidden">{t('common.save')}</span><span className="hidden sm:inline">{t('settings.gateway.save')}</span></>}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* General Settings Tab */}
          {settingsTab === 'general' && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.general.title')}</h3>
                <p className="text-sm text-gray-500 mb-6">{t('settings.general.description')}</p>

                <div className="space-y-6 bg-white p-6 rounded-2xl border border-gray-200">
                  {/* AI Name */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      {t('settings.general.aiNameLabel')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={aiName}
                      onChange={(e) => {
                        setAiName(e.target.value);
                        if (aiNameError) setAiNameError('');
                      }}
                      placeholder={t('settings.general.aiNamePlaceholder')}
                      className={`block w-full px-4 py-2.5 rounded-xl border ${aiNameError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${aiNameError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
                    />
                    {aiNameError ? (
                      <p className="text-xs text-red-500 mt-1.5 font-medium">
                        {aiNameError === 'required' ? t('settings.general.aiNameRequired') : t('settings.general.aiNameTooLong')}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.aiNameHint')}</p>
                    )}
                  </div>

                  {/* Language */}
                  <div className="border-t border-gray-100 pt-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.languageLabel')}</label>
                    <div className="relative">
                      <select
                        value={currentLanguage}
                        onChange={handleLanguageChange}
                        className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      >
                        <option value="zh-CN">{t('settings.general.languageOptions.zh-CN')}</option>
                        <option value="zh-TW">{t('settings.general.languageOptions.zh-TW')}</option>
                        <option value="en">{t('settings.general.languageOptions.en')}</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
                        <ChevronDown className="w-4 h-4" />
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.languageHint')}</p>
                  </div>

                  <div className="border-t border-gray-100 pt-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.historyPageRoundsLabel')}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={historyPageRoundsInput}
                      onChange={handleHistoryPageRoundsChange}
                      onBlur={commitHistoryPageRounds}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitHistoryPageRounds();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      placeholder={t('settings.general.historyPageRoundsPlaceholder')}
                      className="block w-full max-w-[220px] px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.historyPageRoundsHint')}</p>
                  </div>

                  {/* Login Password Toggle */}
                  <div className="border-t border-gray-100 pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <label className="block text-sm font-semibold text-gray-900">{t('settings.general.loginProtectionLabel')}</label>
                        <p className="text-xs text-gray-400 mt-0.5">{t('settings.general.loginProtectionHint')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLoginEnabled(!loginEnabled)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${ loginEnabled ? 'bg-blue-600' : 'bg-gray-300' }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${ loginEnabled ? 'translate-x-6' : 'translate-x-1' }`}
                        />
                      </button>
                    </div>

                    {loginEnabled && (
                      <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                        <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.loginPasswordLabel')}</label>
                        <div className="relative">
                          <input
                            type={showLoginPassword ? "text" : "password"}
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            placeholder={t('settings.general.loginPasswordPlaceholder')}
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
                        <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.loginPasswordHint')}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-center sm:justify-end pt-4">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  {generalError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> {t('settings.general.saveError')}
                    </span>
                  )}
                  <button
                    onClick={handleSaveGeneral}
                    disabled={isLoading}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : generalSaved ? <><Check className="w-4 h-4" /> {t('settings.general.saved')}</> : t('settings.general.save')}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Quick Commands Management Tab */}
          {settingsTab === 'commands' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.commands.title')}</h3>
                <p className="text-sm text-gray-500 mb-6">{t('settings.commands.description')}</p>

                {/* Add/Edit Form */}
                <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 mb-6">
                  <div className="flex flex-col sm:flex-row gap-4 items-end">
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.commandLabel')}</label>
                      <input
                        type="text"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                        placeholder="/models"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                    </div>
                    <div className="flex-[2] w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.descriptionLabel')}</label>
                      <input
                        type="text"
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                        placeholder={t('settings.commands.descriptionPlaceholder')}
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
                        {editingId ? t('settings.commands.save') : t('settings.commands.addNew')}
                      </button>
                      {editingId && (
                        <button
                          onClick={() => { setEditingId(null); setNewCommand(''); setNewDescription(''); }}
                          className="h-[42px] px-4 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all font-bold text-sm flex-1 sm:flex-none"
                        >
                          {t('common.cancel')}
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
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest w-1/3">{t('settings.commands.tableCommand')}</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">{t('settings.commands.tableDescription')}</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right w-24">{t('settings.commands.tableActions')}</th>
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
                                title={t('common.edit')}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={() => handleDeleteCommand(cmd.id)}
                                className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                title={t('common.delete')}
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
                            {t('settings.commands.empty')}
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
              {/* Header */}
              <div className="flex justify-between items-start sm:items-center">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.models.title')}</h3>
                  <p className="text-sm text-gray-500">{t('settings.models.description')}</p>
                </div>
                <button
                  onClick={openAddEndpointModal}
                  className="h-[40px] px-5 rounded-xl bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  {t('settings.models.addEndpoint')}
                </button>
              </div>

              {modelActionError.message && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{modelActionError.message}</div>
                    {modelActionError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {modelActionError.detail}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {modelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                  <X className="w-4 h-4 shrink-0" />
                  {modelError}
                </div>
              )}

              {/* Unified Endpoint + Model List */}
              <div className="space-y-3">
                {knownEndpoints.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-gray-200 px-4 py-12 text-center text-gray-400 text-sm">
                    {t('settings.models.emptyEndpoints')}
                  </div>
                ) : (
                  knownEndpoints.map(epName => {
                    const epModels = models.filter(m => m.id.startsWith(`${epName}/`)).sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
                    const epConfig = endpoints.find(e => e.id === epName) || { id: epName, baseUrl: '', apiKey: '', api: 'openai-completions' };
                    const displayApi = epConfig.api === 'openai-completions' ? 'OpenAI' : 
                                       epConfig.api === 'anthropic-messages' ? 'Anthropic' :
                                       epConfig.api === 'google-genai' ? 'Gemini' : 
                                       epConfig.api === 'ollama' ? 'Ollama' : epConfig.api;
                    const isExpanded = expandedEndpoints.has(epName);

                    return (
                      <div key={epName} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                        {/* Endpoint Header Row */}
                        <div
                          className="flex items-center gap-3 px-4 py-4 cursor-pointer hover:bg-gray-50/80 transition-colors select-none group"
                          onClick={() => toggleEndpointExpanded(epName)}
                        >
                          <ChevronDown className={`w-6 h-6 text-gray-400 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2.5 mb-0.5">
                              <span className="font-semibold text-gray-900 text-base">{epName}</span>
                              <span className="px-2 py-0.5 rounded-md bg-gray-100/80 border border-gray-200 text-gray-500 text-xs font-mono">
                                {displayApi}
                              </span>
                              <span className="hidden sm:inline text-xs text-gray-400">{t('settings.models.modelCount', { count: epModels.length })}</span>
                            </div>
                            <div className="text-sm text-gray-400 truncate">{epConfig.baseUrl || '-'}</div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => {
                                setNewModelEndpoint(epName);
                                setNewModelName('');
                                setNewModelAlias('');
                                setAddModelTestStatus('idle');
                                setTestModelMessage('');
                                setDiscoveredModels([]);
                                setModelSearchQuery('');
                                setIndividualTestStatus({});
                                setShowOnlyConnected(false);
                                setModelError('');
                                setAddModelError('');
                                setAddModelErrorDetail('');
                                setIsAddModelModalOpen(true);
                              }}
                              className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-all"
                              title={t('settings.models.addModel')}
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">{t('settings.models.addModel')}</span>
                            </button>
                            <button
                              onClick={() => openEditEndpointModal(epConfig)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                              title={t('settings.models.editEndpoint')}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteEndpoint(epName, epModels.length)}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                              title={t('settings.models.deleteEntireEndpoint')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Expanded Models Section */}
                        {isExpanded && (
                          <div className="border-t border-gray-100">
                            {epModels.length === 0 ? (
                              <div className="px-6 py-6 text-center text-gray-400 text-sm">
                                {t('settings.models.noModelsPrefix')}
                                <button
                                  onClick={() => {
                                    setNewModelEndpoint(epName);
                                    setNewModelName('');
                                    setNewModelAlias('');
                                    setAddModelTestStatus('idle');
                                    setTestModelMessage('');
                                    setDiscoveredModels([]);
                                    setModelSearchQuery('');
                                    setIndividualTestStatus({});
                                    setShowOnlyConnected(false);
                                    setModelError('');
                                    setAddModelError('');
                                    setAddModelErrorDetail('');
                                    setIsAddModelModalOpen(true);
                                  }}
                                  className="text-blue-600 hover:text-blue-700 font-medium hover:underline"
                                >
                                  {t('settings.models.clickToAdd')}
                                </button>
                              </div>
                            ) : (
                              <table className="w-full text-left border-collapse">
                                <thead>
                                  <tr className="bg-gray-50/80 border-b border-gray-100">
                                    <th className="px-6 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableModelId')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableAlias')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap w-20 text-xs">{t('settings.models.tableStatus')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-right w-28 text-xs">{t('settings.models.tableActions')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {epModels.map((model, idx) => {
                                    const modelName = model.id.substring(epName.length + 1);
                                    return (
                                      <Fragment key={model.id}>
                                      <tr className={`transition-colors text-sm ${editingModelId === model.id ? 'bg-blue-50/30' : 'group'}`}>
                                        <td className="px-6 py-3 text-gray-700">
                                          <div className="text-[13px]">{modelName}</div>
                                        </td>
                                        <td className="px-4 py-3 text-gray-600 text-[13px]">
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
                                              placeholder={t('settings.models.aliasPlaceholder')}
                                              className="w-full px-2 py-1 text-[13px] border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                            />
                                          ) : (
                                            model.alias || <span className="text-gray-300">-</span>
                                          )}
                                        </td>
                                        <td className="px-4 py-3">
                                          <div className="flex items-center gap-2">
                                            {(() => {
                                              const testData = existingModelTestStatus[model.id];
                                              if (testData?.status === 'testing') return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
                                              if (testData?.status === 'success') return <Check className="w-4 h-4 text-green-500" />;
                                              if (testData?.status === 'error') return <span title={testData.detail || testData.message}><X className="w-4 h-4 text-red-500" /></span>;
                                              return null;
                                            })()}
                                            {model.primary ? (
                                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 whitespace-nowrap">
                                                {t('settings.models.defaultTag')}
                                              </span>
                                            ) : null}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          {editingModelId === model.id ? (
                                            <div className="flex items-center justify-end gap-1">
                                              <button
                                                onClick={handleSaveModelAlias}
                                                disabled={isLoading}
                                                className="p-1.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                                                title={t('common.save')}
                                              >
                                                <Check className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                onClick={cancelEditModel}
                                                className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                                title={t('common.cancel')}
                                              >
                                                <X className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                              <button
                                                onClick={() => startEditModel(model)}
                                                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                                title={t('settings.models.editAlias')}
                                              >
                                                <Edit2 className="w-4 h-4" />
                                              </button>
                                              {!model.primary && (
                                                <button
                                                  onClick={() => handleSetDefaultModel(model.id)}
                                                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                                  title={t('settings.models.setDefault')}
                                                >
                                                  <Check className="w-4 h-4" />
                                                </button>
                                              )}
                                              <button
                                                onClick={() => {
                                                  handleTestExistingSingleModel(model.id, epName, modelName);
                                                }}
                                                disabled={existingModelTestStatus[model.id]?.status === 'testing'}
                                                className={`p-1.5 rounded-lg transition-colors ${ existingModelTestStatus[model.id]?.status === 'testing' ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-purple-600 hover:bg-purple-50' }`}
                                                title={t('settings.models.testAvailability')}
                                              >
                                                <Activity className="w-4 h-4" />
                                              </button>
                                              <button
                                                onClick={() => handleDeleteModel(model.id, model.primary)}
                                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                                title={t('common.delete')}
                                              >
                                                <Trash2 className="w-4 h-4" />
                                              </button>
                                            </div>
                                          )}
                                        </td>
                                      </tr>
                                      {/* Capabilities row */}
                                      {editingModelId === model.id ? (
                                        <tr className="bg-blue-50/30">
                                          <td colSpan={3} className="px-6 pt-0 pb-3">
                                            <div className="flex flex-nowrap gap-1">
                                              {CAPABILITIES.map(cap => {
                                                const active = editingInput.includes(cap.id);
                                                return (
                                                  <button
                                                    key={cap.id}
                                                    type="button"
                                                    onClick={() => setEditingInput(prev =>
                                                      prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                                                    )}
                                                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200' }`}
                                                  >
                                                    <cap.Icon className="w-2.5 h-2.5" />
                                                    {cap.label}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </td>
                                          <td></td>
                                        </tr>
                                      ) : (
                                        (model.input || []).filter(i => i !== 'text').length > 0 && (
                                          <tr>
                                            <td colSpan={3} className="px-6 pt-0 pb-3">
                                              <div className="flex flex-nowrap gap-1">
                                                {CAPABILITIES.filter(c => (model.input || []).includes(c.id)).map(cap => (
                                                  <span key={cap.id} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border text-blue-600 bg-blue-50 border-blue-200">
                                                    <cap.Icon className="w-2.5 h-2.5" />
                                                    {cap.label}
                                                  </span>
                                                ))}
                                              </div>
                                            </td>
                                            <td></td>
                                          </tr>
                                        )
                                      )}
                                      {idx < epModels.length - 1 && (
                                        <tr><td colSpan={4} className="p-0"><div className="mx-5 border-b border-gray-200"></div></td></tr>
                                      )}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-4 pt-2">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {t('settings.models.defaultModelTitle')}
                  </h3>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    {t('settings.models.defaultModelDescription')}
                  </p>
                </div>

                {defaultModelError.message ? (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{defaultModelError.message}</div>
                    {defaultModelError.detail ? (
                      <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {defaultModelError.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
                  <ModelSinglePicker
                    availableModels={[...models].sort((a, b) => {
                      const labelA = a.alias || a.id;
                      const labelB = b.alias || b.id;
                      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
                    })}
                    selectedModelId={defaultModelId}
                    onSelectedModelIdChange={(id) => {
                      void handleSaveDefaultModelSelection(id);
                    }}
                    placeholder={t('settings.models.defaultModelPlaceholder')}
                    emptyText={t('settings.models.defaultModelEmpty')}
                    allModelsTabLabel={t('sidebar.allModels')}
                    defaultBadgeLabel={t('settings.models.defaultTag')}
                    visionBadgeLabel={t('sidebar.visionModel')}
                    disabled={isSavingDefaultModel || models.length === 0}
                  />
                </div>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {t('settings.models.globalFallbackTitle')}
                    </h3>
                    <p className="text-sm text-gray-500 leading-relaxed">
                      {t('settings.models.globalFallbackDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={globalFallbackMode !== 'disabled'}
                    aria-label={t('settings.models.globalFallbackTitle')}
                    onClick={() => setGlobalFallbackMode((prev) => prev === 'disabled' ? 'custom' : 'disabled')}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${globalFallbackMode !== 'disabled' ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${globalFallbackMode !== 'disabled' ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                  </button>
                </div>

                {globalFallbackError.message ? (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{globalFallbackError.message}</div>
                    {globalFallbackError.detail ? (
                      <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {globalFallbackError.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {globalFallbackMode !== 'disabled' ? (
                  <ModelFallbackEditor
                    availableModels={[...models].sort((a, b) => {
                      const labelA = a.alias || a.id;
                      const labelB = b.alias || b.id;
                      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
                    })}
                    mode={globalFallbackMode}
                    onModeChange={(mode) => setGlobalFallbackMode(mode)}
                    selectedModelIds={globalFallbacks}
                    onSelectedModelIdsChange={(ids) => {
                      setGlobalFallbacks(ids);
                      if (ids.length === 0) {
                        setGlobalFallbackMode('disabled');
                      } else if (globalFallbackMode !== 'custom') {
                        setGlobalFallbackMode('custom');
                      }
                    }}
                    excludedModelIds={currentPrimaryModelId ? [currentPrimaryModelId] : []}
                    title=""
                    description=""
                    customLabel={t('settings.models.fallbackModeCustom')}
                    customHint=""
                    disabledLabel={t('settings.models.fallbackModeDisabled')}
                    disabledHint=""
                    hideModeSelector
                    searchPlaceholder={t('settings.models.fallbackSearchPlaceholder')}
                    selectedTitle={t('settings.models.fallbackSelectedTitle')}
                    availableTitle={t('settings.models.fallbackAvailableTitle')}
                    emptySelectedText={t('settings.models.fallbackSelectedEmpty')}
                    emptyAvailableText={t('settings.models.fallbackAvailableEmpty')}
                    defaultBadgeLabel={t('settings.models.defaultTag')}
                    allModelsTabLabel={t('sidebar.allModels')}
                    visionBadgeLabel={t('sidebar.visionModel')}
                    selectionUiVariant="model-picker"
                    className="min-w-0"
                  />
                ) : null}
              </div>
            </div>
          )}

            {/* About System Tab */}

            {settingsTab === 'about' && (
              <div className="space-y-6">
                <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6 w-full">
                  <div className="flex w-full flex-col gap-6">
                  
                  {/* Header */}
                  <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="w-full text-left sm:w-auto">
                      <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">OpenClaw</div>
                      <div className="text-[1.15rem] font-bold text-gray-400 tracking-widest uppercase leading-tight">CHAT GATEWAY</div>
                    </div>
                    <div className="flex flex-col items-start gap-3 sm:items-end">
                      <div className="flex items-baseline text-left text-sm text-gray-700 sm:text-right">
                        <span className="font-normal">
                          {t('settings.about.currentVersionLabel')}:&nbsp;
                        </span>
                        <span className="font-normal text-gray-900">
                          {isLoadingAppVersion
                            ? t('settings.about.loadingVersion')
                            : appVersionInfo?.version || t('settings.about.unavailable')}
                        </span>
                      </div>
                      <div className={updateProgressWidthClass}>
                        <button
                          type="button"
                          onClick={handleLatestVersionAction}
                          disabled={!updateProgressVisual.clickable}
                          title={updateProgressTitle}
                          className={`relative overflow-hidden rounded-xl border text-left transition-colors ${updateProgressButtonWidthClass} ${updateProgressToneClasses.container} ${updateProgressVisual.clickable ? updateProgressToneClasses.hover : 'cursor-default'} ${!updateProgressVisual.clickable ? 'opacity-90' : ''}`}
                        >
                          <div
                            className={`absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500 ease-out ${updateProgressToneClasses.fill}`}
                            style={{ width: `${Math.min(Math.max(updateProgressVisual.progress, 0), 100)}%` }}
                          />
                          <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-center">
                            {updateProgressVisual.showSpinner
                              ? <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${updateProgressToneClasses.icon}`} />
                              : updateProgressVisual.icon === 'success'
                                ? <Check className={`h-4 w-4 shrink-0 ${updateProgressToneClasses.icon}`} />
                                : updateProgressVisual.icon === 'error'
                                  ? <X className={`h-4 w-4 shrink-0 ${updateProgressToneClasses.icon}`} />
                                  : <Activity className={`h-4 w-4 shrink-0 ${updateProgressToneClasses.icon}`} />}
                            <span className={`truncate whitespace-nowrap text-sm font-semibold leading-5 ${updateProgressToneClasses.text}`}>
                              {updateProgressVisual.label}
                            </span>
                          </div>
                        </button>
                        {updateProgressVisual.detail ? (
                          <div className={`mt-2 whitespace-pre-wrap rounded-xl border px-4 py-3 text-sm ${updateProgressToneClasses.detail}`}>
                            {updateProgressVisual.detail}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="w-full border-t border-gray-200" />

                  {appVersionError.message && (
                    <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                      <div className="font-semibold">{appVersionError.message}</div>
                      {appVersionError.detail ? <div className="mt-1 whitespace-pre-wrap text-red-600">{appVersionError.detail}</div> : null}
                    </div>
                  )}

                  {/* Author Info */}
                  <div className="w-full text-center text-xl font-medium leading-8 text-gray-700">
                    {t('settings.about.authorName')}
                  </div>

                  {/* Links Row */}
                  <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
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
                    <span>{t('settings.about.tgGroup')}</span>
                  </a>
                  <a 
                    href="https://blog.angeworld.cc/market" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-2 text-[#3b82f6] hover:text-blue-700 transition-colors group text-[13px] sm:text-[15px] font-medium"
                  >
                    <ShoppingBag className="w-5 h-5 text-[#ef4444] group-hover:-translate-y-0.5 transition-transform" />
                    <span>{t('settings.about.market')}</span>
                  </a>
                </div>

                {/* API Button Row */}
                <div className="w-full flex flex-col items-center gap-3 px-2">
                  <a 
                    href="https://ai.opendoor.cn" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center justify-center px-6 py-2.5 rounded-xl sm:rounded-full bg-[#fefce8] border border-blue-300 text-[#3b82f6] hover:bg-yellow-100 hover:border-blue-400 transition-all font-bold text-[11px] min-[380px]:text-[12px] sm:text-[14px] max-w-full text-center"
                  >
                    {t('settings.about.openDoorApiLabel')}
                  </a>
                  <a 
                    href="https://ai.superdoor.top/register?promo=ANGEWORLD" 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center justify-center px-6 py-2.5 rounded-xl sm:rounded-full bg-[#fefce8] border border-blue-300 text-[#3b82f6] hover:bg-yellow-100 hover:border-blue-400 transition-all font-bold text-[11px] min-[380px]:text-[12px] sm:text-[14px] max-w-full text-center"
                  >
                    {t('settings.about.superDoorApiLabel')}
                  </a>
                </div>

                  </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {isUpdateCancelModalOpen && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => {
              if (!isCancellingUpdate) {
                setIsUpdateCancelModalOpen(false);
              }
            }}
          />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${updateStatusInfo?.canCancel ? 'bg-amber-100' : 'bg-blue-100'}`}>
                <Activity className={`h-6 w-6 ${updateStatusInfo?.canCancel ? 'text-amber-600' : 'text-blue-600'}`} />
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{updateCancelModalTitle}</h3>
              <p className="text-sm text-gray-500">{updateCancelModalMessage}</p>
              {!updateStatusInfo?.canCancel && updateCancelUnsafeDetail ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{updateCancelUnsafeDetail}</p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setIsUpdateCancelModalOpen(false)}
                disabled={isCancellingUpdate}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {updateStatusInfo?.canCancel ? t('settings.about.updateCancelKeepRunning') : t('common.gotIt')}
              </button>
              {updateStatusInfo?.canCancel ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmCancelUpdate()}
                  disabled={isCancellingUpdate}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCancellingUpdate ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.about.updateStoppingButton')}
                    </span>
                  ) : (
                    t('settings.about.updateCancelConfirmAction')
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Shared Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('common.confirmDelete')}</h3>
              <p className="text-sm text-gray-500">{deleteModalMessage}</p>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={executeDelete}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                {t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Endpoint Add/Edit Modal */}
      {isEndpointModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsEndpointModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-lg font-bold text-gray-900">
                {editingEndpoint ? t('settings.models.endpointModalEditTitle') : t('settings.models.endpointModalCreateTitle')}
              </h3>
              <button
                onClick={() => setIsEndpointModalOpen(false)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {endpointModalError.message && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{endpointModalError.message}</div>
                    {endpointModalError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {endpointModalError.detail}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {modelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                  <X className="w-4 h-4 shrink-0" />
                  {modelError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  {t('settings.models.endpointNameLabel')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newEndpointData.id}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, id: e.target.value })}
                  disabled={!!editingEndpoint}
                  placeholder={t('settings.models.endpointNamePlaceholder')}
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>

	              <div>
	                <label className="block text-sm font-medium text-gray-900 mb-1.5">
	                  {t('settings.models.apiTypeLabel')} <span className="text-red-500">*</span>
	                </label>
	                <div className="relative">
	                  <select
	                    value={newEndpointData.api}
	                    onChange={(e) => setNewEndpointData({ ...newEndpointData, api: e.target.value })}
	                    className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
	                  >
	                    <option value="openai-completions">{t('settings.models.openaiCompatibleLabel')}</option>
	                    <option value="anthropic-messages">Anthropic (Messages)</option>
	                    <option value="google-genai">Google Gemini (GenAI)</option>
	                    <option value="cohere-chat">Cohere Chat</option>
	                    <option value="mistral-chat">Mistral Chat</option>
	                    <option value="ollama">Ollama</option>
	                  </select>
	                  <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
	                    <ChevronDown className="w-4 h-4" />
	                  </span>
	                </div>
	                <p className="text-xs text-gray-500 mt-1.5 ml-1">{t('settings.models.apiTypeHint')}</p>
	              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  {t('settings.models.baseUrlLabel')} <span className="text-red-500">*</span>
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
                  {t('settings.models.apiKeyLabel')}
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
                className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTestEndpoint}
                disabled={endpointTestStatus === 'testing' || !newEndpointData.baseUrl || !newEndpointData.api}
                className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ endpointTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : endpointTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : endpointTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-white text-gray-700 border border-gray-200 hover:text-purple-700 hover:border-purple-200 hover:bg-purple-50' }`}
                title={endpointTestStatus !== 'idle' ? endpointTestMessage : t('settings.models.pretestEndpoint')}
              >
                {endpointTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                 endpointTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                 endpointTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                 <Activity className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {endpointTestStatus === 'idle' ? t('common.test') : endpointTestMessage}
                </span>
              </button>
              <button
                type="button"
                onClick={handleSaveEndpoint}
                disabled={isLoading}
                className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-sm whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.models.saveEndpoint')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* End of content */}

      {isAddModelModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsAddModelModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl min-h-[400px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
            <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-start bg-gray-50/50 rounded-t-2xl">
              <div>
                <h3 className="text-lg font-bold text-gray-900 mt-1">{t('settings.models.addModelTitle')}</h3>
                <div className="text-xs text-gray-500 mt-1">
                  {t('settings.models.addModelIntro')}
                  <div className="text-red-500 font-bold mt-1 space-y-0.5 leading-relaxed">
                    <p>{t('settings.models.addModelNoteAutoFetch')}</p>
                    <p>{t('settings.models.addModelNoteTestConsumesToken')}</p>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsAddModelModalOpen(false)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-5 flex-1 overflow-visible flex flex-col">
              {addModelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{addModelError}</div>
                    {addModelErrorDetail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {addModelErrorDetail}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 z-[210]">
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">
                    {t('settings.models.endpointLabel')} <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={isEndpointDropdownOpen ? endpointSearchQuery : newModelEndpoint}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEndpointSearchQuery(val);
                        if (!isEndpointDropdownOpen) setIsEndpointDropdownOpen(true);
                      }}
                      onFocus={() => {
                        setEndpointSearchQuery('');
                        setIsEndpointDropdownOpen(true);
                      }}
                      placeholder={newModelEndpoint ? newModelEndpoint : t('settings.models.endpointPlaceholder')}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all text-sm font-mono text-gray-900 pr-8"
                    />
                    {newModelEndpoint && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNewModelEndpoint('');
                          setEndpointSearchQuery('');
                          setIsEndpointDropdownOpen(false);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                        title={t('common.clear')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {isEndpointDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-[10]" onClick={() => {
                        setIsEndpointDropdownOpen(false);
                        if (endpointSearchQuery && !newModelEndpoint) {
                          setNewModelEndpoint(endpointSearchQuery.trim());
                          handleDiscoverModels(endpointSearchQuery.trim());
                        }
                      }} />
                      <div className="absolute z-[20] top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl max-h-[160px] overflow-y-auto">
                        {knownEndpoints
                          .filter(ep => {
                            if (!endpointSearchQuery) return true;
                            return ep.toLowerCase().includes(endpointSearchQuery.toLowerCase());
                          })
                          .map((ep, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setNewModelEndpoint(ep);
                                setHasFetched(false);
                                setEndpointSearchQuery('');
                                setIsEndpointDropdownOpen(false);
                              }}
                              className={`w-full text-left px-4 py-2 text-sm hover:bg-blue-50 transition-colors flex items-center gap-2 ${ newModelEndpoint === ep ? 'bg-blue-50 text-blue-600' : 'text-gray-700' }`}
                            >
                              <span className="font-mono text-xs max-w-[200px] truncate">{ep}</span>
                            </button>
                          ))
                        }
                        {endpointSearchQuery && !knownEndpoints.some(ep => ep.toLowerCase() === endpointSearchQuery.toLowerCase()) && (
                          <button
                            type="button"
                            onClick={() => {
                              const val = endpointSearchQuery.trim();
                              setNewModelEndpoint(val);
                              setHasFetched(false);
                              setEndpointSearchQuery('');
                              setIsEndpointDropdownOpen(false);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-100 bg-gray-50 flex items-center justify-between"
                          >
                            <span>{t('settings.models.useNewEndpoint')} <strong className="font-mono">{endpointSearchQuery}</strong></span>
                            <Plus className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('settings.models.aliasOptionalLabel')}</label>
                  <input
                    type="text"
                    value={newModelAlias}
                    onChange={(e) => setNewModelAlias(e.target.value)}
                    placeholder={t('settings.models.aliasExamplePlaceholder')}
                    className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                </div>
              </div>

              <div className="flex-1 flex flex-col relative z-10" ref={dropdownRef}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-900">
                    {t('settings.models.modelIdLabel')} <span className="text-red-500">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (isDiscovering) {
                        cancelDiscovery();
                      } else if (hasFetched && discoveredModels.length > 0) {
                        setHasFetched(false);
                      } else {
                        handleDiscoverModels(newModelEndpoint.trim());
                      }
                    }}
                    disabled={!newModelEndpoint.trim()}
                    title={isDiscovering ? t('settings.models.fetchingModelsTitle') : ""}
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all border flex items-center gap-1.5 ${ !newModelEndpoint.trim() ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isDiscovering ? 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50' }`}
                  >
                    {isDiscovering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isDiscovering 
                      ? t('settings.models.autoFetching')
                      : (hasFetched && discoveredModels.length > 0) 
                        ? t('settings.models.manualInput')
                        : t('settings.models.autoFetch')
                    }
                  </button>
                </div>
                <div 
                  className="relative cursor-pointer block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus-within:bg-white focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500/20 transition-all text-sm min-h-[46px] flex items-center gap-2 flex-wrap"
                  onClick={() => {
                    if (hasFetched && discoveredModels.length > 0) {
                      setIsModelDropdownOpen(true);
                    }
                  }}
                >
                  <input
                    type="text"
                    value={newModelName}
                    onChange={(e) => {
                      setNewModelName(e.target.value);
                      setModelSearchQuery(e.target.value);
                      // Auto-detect capabilities when user types a model name
                      if (e.target.value.trim()) {
                        setNewModelInput(guessCapabilities(e.target.value.trim()));
                      }
                    }}
                    placeholder={!hasFetched ? t('settings.models.modelPlaceholderNoFetch') : (discoveredModels.length > 0 ? t('settings.models.modelPlaceholderFetched', { count: discoveredModels.length }) : t('settings.models.modelPlaceholderEmpty'))}
                    className="bg-transparent border-none outline-none w-full text-sm placeholder-gray-400 py-1"
                    onFocus={() => {
                      if (hasFetched && discoveredModels.length > 0) {
                        setIsModelDropdownOpen(true);
                      }
                    }}
                  />
                  {newModelName && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNewModelName('');
                        setModelSearchQuery('');
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                      title={t('common.clear')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {isModelDropdownOpen && (hasFetched && discoveredModels.length > 0) && (
                  <>
                  <div className="fixed inset-0 z-[40]" onClick={(e) => { e.stopPropagation(); setIsModelDropdownOpen(false); }} />
                  <div 
                    className="absolute z-50 left-0 right-0 top-[80px] bg-white border border-gray-200 rounded-xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ maxHeight: modelDropdownMaxHeight ? `${modelDropdownMaxHeight}px` : '350px' }}
                  >
                    {(() => {
                      const visibleDiscoveredModels = discoveredModels.filter(m => {
                        if (showOnlyConnected && individualTestStatus[m]?.status !== 'success') return false;
                        return m.toLowerCase().includes(modelSearchQuery.toLowerCase());
                      }).sort((a, b) => a.localeCompare(b));
                      const isAnyTesting = Object.values(individualTestStatus).some(t => t.status === 'testing');
                      const hasAnyTests = Object.keys(individualTestStatus).length > 0;

                      return (
                        <>
                          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 bg-gray-50/95 backdrop-blur">
                            <span className="text-sm text-gray-700 font-semibold flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                              {t('settings.models.modelListTitle', { count: visibleDiscoveredModels.length })}
                            </span>
                            
                            <div className="flex items-center gap-3">
                              <div className="flex items-center bg-gray-200/50 p-0.5 rounded-lg border border-gray-200/50">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(false); }}
                                  disabled={isAnyTesting}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ !showOnlyConnected ? 'bg-white text-gray-800 border-gray-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${isAnyTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                  {t('settings.models.filterAll')}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(true); }}
                                  disabled={isAnyTesting || !hasAnyTests}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ showOnlyConnected ? 'bg-white text-green-700 border-green-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${(isAnyTesting || !hasAnyTests) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  title={!hasAnyTests ? t('settings.models.noConnectivityTestsYet') : ""}
                                >
                                  {t('settings.models.filterValid')}
                                </button>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                if (isAnyTesting) {
                                  cancelTestAll();
                                } else {
                                  handleTestAllFiltered();
                                }
                              }}
                              disabled={!isAnyTesting && visibleDiscoveredModels.length === 0}
                              title={isAnyTesting ? t('settings.models.fetchingModelsTitle') : ""}
                              className={`text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all border ${ !isAnyTesting && visibleDiscoveredModels.length === 0 ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isAnyTesting ? 'text-red-600 bg-red-50 hover:bg-red-100 border-red-200' : 'text-indigo-700 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border-indigo-200' }`}
                            >
                              {isAnyTesting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                              {isAnyTesting
                                  ? t('settings.models.testingCount', { count: Object.values(individualTestStatus).filter(t => t.status === 'testing').length })
                                  : t('settings.models.testModels')
                                }
                              </button>
                            </div>
                          </div>
                          
                          <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5 min-h-[100px]" onClick={() => setIsModelDropdownOpen(false)}>
                            {visibleDiscoveredModels.length === 0 && (
                              <div className="py-8 text-center text-gray-400 text-sm">
                                {showOnlyConnected ? t('settings.models.noValidModelsFound') : t('settings.models.noMatchingModels', { query: modelSearchQuery })}
                              </div>
                            )}
                            {visibleDiscoveredModels.map(m => {
                              const isExisting = existingModelIds.has(`${newModelEndpoint.trim()}/${m}`);
                              const testData = individualTestStatus[m];
                              const isSelected = newModelName === m;

                              return (
                                <div 
                                  key={m}
                                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${ isExisting ? 'opacity-60 bg-gray-50/50 cursor-not-allowed' : isSelected ? 'bg-blue-50/80 border-blue-100 font-medium cursor-pointer ' : 'hover:bg-gray-100 cursor-pointer border-transparent' } border`}
                                  onClick={(e) => {
                                    if (isExisting) return;
                                    e.preventDefault();
                                    if (isSelected) {
                                      setNewModelName('');
                                    } else {
                                      setNewModelName(m);
                                      setIsModelDropdownOpen(false);
                                      // Auto-detect capabilities when a model is selected from dropdown
                                      setNewModelInput(guessCapabilities(m));
                                    }
                                  }}
                                >
                                  <div className="flex items-center gap-3 overflow-hidden flex-1">
                                    <span className={`truncate ${isSelected ? 'text-blue-900' : 'text-gray-700'}`} title={m}>{m}</span>
                                    {isExisting && <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full ml-1 shrink-0 font-medium">{t('settings.models.alreadyInUse')}</span>}
                                  </div>

                                  {!isExisting && (
                                    <div className="flex items-center gap-2 shrink-0 ml-3" onClick={e => e.stopPropagation()}>
                                      {testData?.status === 'testing' && <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />}
                                      {testData?.status === 'success' && <span title={t('settings.models.valid')}><Check className="w-3.5 h-3.5 text-green-500" /></span>}
                                      {testData?.status === 'error' && <span title={testData.detail || testData.message}><X className="w-3.5 h-3.5 text-red-500" /></span>}
                                      
                                      <button 
                                        onClick={(e) => handleTestSingleModel(m, e)}
                                        className="text-xs text-gray-500 hover:text-indigo-600 px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                                        title={t('settings.models.testSingleModel')}
                                      >
                                        {t('common.test')}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  </>
                )}
              </div>

              {/* Model Capabilities Section */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-900">{t('settings.models.capabilitiesLabel')}</label>
                  <span className="text-xs text-gray-400">{t('settings.models.capabilitiesHint')}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CAPABILITIES.map(cap => {
                    const active = newModelInput.includes(cap.id);
                    return (
                      <button
                        key={cap.id}
                        type="button"
                        onClick={() => setNewModelInput(prev =>
                          prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                        )}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200 hover:bg-gray-100' }`}
                      >
                        <cap.Icon className="w-3.5 h-3.5" />
                        {cap.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setIsAddModelModalOpen(false)}
                className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTestModel}
                disabled={addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ addModelTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : addModelTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : addModelTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:text-indigo-800 hover:bg-indigo-100' }`}
                title={addModelTestStatus !== 'idle' ? addModelTestMessage : t('settings.models.testThisModel')}
              >
                {addModelTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                 addModelTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                 addModelTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                 <Activity className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {addModelTestStatus === 'idle' ? t('common.test') : addModelTestMessage}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleAddModel()}
                disabled={isLoading || addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('settings.models.add')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showForceAddModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <h3 className="text-xl font-bold text-gray-900 mb-2">{t('settings.models.forceAddTitle')}</h3>
              <p className="text-sm text-gray-700 mb-6 bg-red-50 p-3 rounded-lg border border-red-100">{testModelMessage}</p>
              <p className="text-sm text-gray-600 mb-6">{t('settings.models.forceAddDescription')}</p>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setShowForceAddModal(false)}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowForceAddModal(false);
                    handleAddModel();
                  }}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors cursor-pointer"
                >
                  {t('settings.models.forceAdd')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gateway Error Modal */}
      {gatewayErrorModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => setGatewayErrorModalOpen(false)}></div>
          <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-8 text-center">
	              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><X className="h-8 w-8 text-red-500" /></div>
	              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('settings.gateway.configErrorTitle')}</h3>
	              <p className="text-sm text-gray-500 leading-relaxed px-2">{gatewayErrorMessage}</p>
                {gatewayErrorDetail && (
                  <div className="mt-4 text-left bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">{t('settings.gateway.errorDetailLabel')}</p>
                    <p className="text-xs text-gray-500 whitespace-pre-wrap break-all font-mono">{gatewayErrorDetail}</p>
                  </div>
                )}
	            </div>
            <div className="p-5 bg-gray-50/80 border-t border-gray-100">
              <button type="button" onClick={() => setGatewayErrorModalOpen(false)} className="w-full px-4 py-3 text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.gotIt')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
