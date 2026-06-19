import { useEffect, useRef } from "react";

class VoiceControlContextRegistry {
  private providers = new Map<string, () => Record<string, unknown>>();

  /**
   * Register a context provider for the current screen/view.
   * Returns a dispose function to unregister on unmount.
   */
  register(key: string, provider: () => Record<string, unknown>): () => void {
    this.providers.set(key, provider);
    return () => {
      this.providers.delete(key);
    };
  }

  /**
   * Collect all registered view contexts into a single object.
   */
  collect(): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    for (const [key, provider] of this.providers.entries()) {
      try {
        context[key] = provider();
      } catch (err) {
        console.error(`[VoiceControlContext] Failed to collect context for "${key}":`, err);
      }
    }
    return context;
  }
}

export const voiceControlContextRegistry = new VoiceControlContextRegistry();

/**
 * Hook to dynamically contribute structured page context to the voice control recorder.
 * Automatically handles registration and cleanup.
 */
export function useVoiceControlContext(
  key: string,
  provider: () => Record<string, unknown>
): void {
  // Store provider in a ref so callers don't need to wrap in useCallback.
  // The registry always calls the latest version; registration itself only
  // fires when `key` changes, not on every render.
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  });

  useEffect(() => {
    return voiceControlContextRegistry.register(key, () => providerRef.current());
  }, [key]);
}
