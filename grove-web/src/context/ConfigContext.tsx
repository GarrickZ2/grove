import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getConfig, type Config } from '../api/config';
import { checkAllDependencies } from '../api';


interface ConfigContextValue {
  config: Config | null;
  loading: boolean;
  refresh: () => Promise<void>;
  terminalAvailable: boolean;
  updateAvailability: (terminal: boolean) => void;
}

const ConfigContext = createContext<ConfigContextValue | undefined>(undefined);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [terminalAvailable, setTerminalAvailable] = useState(true);

  const loadConfig = async () => {
    setLoading(true);
    let cfg: Config | null = null;
    try {
      cfg = await getConfig();
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load config:', error);
      cfg = null;
    }
    setLoading(false);
    return cfg;
  };

  const checkAvailability = useCallback(async (cfg: Config | null) => {
    let envResult: Awaited<ReturnType<typeof checkAllDependencies>> | null = null;
    try {
      envResult = await checkAllDependencies();
    } catch {
      // On error, keep defaults
    }
    if (!envResult) return;
    // Terminal: direct mode always available, or tmux/zellij installed
    const isDirectMode = cfg?.web?.terminal_mode === 'direct';
    const tmuxDep = envResult.dependencies.find(d => d.name === 'tmux');
    const zellijDep = envResult.dependencies.find(d => d.name === 'zellij');
    const tmux = tmuxDep?.installed ?? false;
    const zellij = zellijDep?.installed ?? false;
    setTerminalAvailable(isDirectMode || tmux || zellij);
  }, []);

  const updateAvailability = useCallback((terminal: boolean) => {
    setTerminalAvailable(terminal);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
      await checkAvailability(cfg);
    } catch (error) {
      console.error('Failed to refresh config:', error);
    }
  }, [checkAvailability]);

  useEffect(() => {
    void (async () => {
      const cfg = await loadConfig();
      await checkAvailability(cfg);
    })();
  }, [checkAvailability]);

  return (
    <ConfigContext.Provider value={{
      config,
      loading,
      refresh,
      terminalAvailable,
      updateAvailability,
    }}>
      {children}
    </ConfigContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within ConfigProvider');
  }
  return context;
}
