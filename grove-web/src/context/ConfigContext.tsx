import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { getConfig, type Config } from '../api/config';

interface ConfigContextValue {
  config: Config | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextValue | undefined>(undefined);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  return (
    <ConfigContext.Provider value={{ config, loading, refresh: loadConfig }}>
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
