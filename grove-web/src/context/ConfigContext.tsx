import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getConfig, type Config } from '../api/config';
import { checkAllDependencies, checkCommands } from '../api';
import { agentOptions } from '../components/ui';

// ACP-compatible built-in agent IDs (agents that have an acpCheck field)
const acpCompatibleAgentIds = ["claude", "traecli", "codex", "kimi", "gh-copilot", "gemini", "qwen", "opencode"];

interface ConfigContextValue {
  config: Config | null;
  loading: boolean;
  refresh: () => Promise<void>;
  terminalAvailable: boolean;
  chatAvailable: boolean;
  updateAvailability: (terminal: boolean, chat: boolean) => void;
}

const ConfigContext = createContext<ConfigContextValue | undefined>(undefined);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [terminalAvailable, setTerminalAvailable] = useState(true);
  const [chatAvailable, setChatAvailable] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const cfg = await getConfig();
      setConfig(cfg);
      return cfg;
    } catch (error) {
      console.error('Failed to load config:', error);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const checkAvailability = useCallback(async (cfg: Config | null) => {
    try {
      // Collect all ACP check commands
      const acpCheckCmds = new Set<string>();
      for (const opt of agentOptions) {
        if (opt.acpCheck && acpCompatibleAgentIds.includes(opt.id)) {
          acpCheckCmds.add(opt.acpCheck);
        }
      }

      const [envResult, cmdResults] = await Promise.all([
        checkAllDependencies(),
        checkCommands([...acpCheckCmds]),
      ]);

      // Terminal: tmux or zellij installed
      const tmux = envResult.dependencies.find(d => d.name === 'tmux')?.installed ?? false;
      const zellij = envResult.dependencies.find(d => d.name === 'zellij')?.installed ?? false;
      setTerminalAvailable(tmux || zellij);

      // Chat: at least one ACP agent command exists OR custom agents configured
      const hasAnyAcp = agentOptions
        .filter(a => acpCompatibleAgentIds.includes(a.id) && a.acpCheck)
        .some(a => cmdResults[a.acpCheck!] === true);
      const hasCustom = (cfg?.acp?.custom_agents?.length ?? 0) > 0;
      setChatAvailable(hasAnyAcp || hasCustom);
    } catch {
      // On error, keep defaults
    }
  }, []);

  const updateAvailability = useCallback((terminal: boolean, chat: boolean) => {
    setTerminalAvailable(terminal);
    setChatAvailable(chat);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to refresh config:', error);
    }
  }, []);

  useEffect(() => {
    loadConfig().then(cfg => checkAvailability(cfg));
  }, [checkAvailability]);

  return (
    <ConfigContext.Provider value={{
      config,
      loading,
      refresh,
      terminalAvailable,
      chatAvailable,
      updateAvailability,
    }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within ConfigProvider');
  }
  return context;
}
