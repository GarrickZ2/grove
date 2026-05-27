import type { ModelItem } from "../../../api/statistics";

export interface ModelRates {
  input: number;      // per token in USD
  cached: number;     // per token in USD
  output: number;     // per token in USD
}

// Pricing per 1M tokens in USD
const PRICING_PER_MILLION: Record<string, ModelRates> = {
  "claude-3-5-sonnet": { input: 3.00, cached: 0.75, output: 15.00 },
  "claude-3-opus": { input: 15.00, cached: 3.75, output: 75.00 },
  "claude-3-haiku": { input: 0.25, cached: 0.03, output: 1.25 },
  "gemini-1.5-pro": { input: 1.25, cached: 0.3125, output: 5.00 },
  "gemini-1.5-flash": { input: 0.075, cached: 0.01875, output: 0.30 },
  "gpt-4o": { input: 2.50, cached: 1.25, output: 10.00 },
  "gpt-4o-mini": { input: 0.150, cached: 0.075, output: 0.60 },
  "deepseek-chat": { input: 0.14, cached: 0.014, output: 0.28 },
  "deepseek-coder": { input: 0.14, cached: 0.014, output: 0.28 },
};

const DEFAULT_RATES: ModelRates = {
  input: 1.50 / 1_000_000,
  cached: 0.375 / 1_000_000,
  output: 6.00 / 1_000_000,
};

export function getModelRates(modelName: string): ModelRates {
  const name = modelName.toLowerCase();
  for (const [key, rates] of Object.entries(PRICING_PER_MILLION)) {
    if (name.includes(key)) {
      return {
        input: rates.input / 1_000_000,
        cached: rates.cached / 1_000_000,
        output: rates.output / 1_000_000,
      };
    }
  }
  return DEFAULT_RATES;
}

export interface AverageRates {
  input: number;
  cached: number;
  output: number;
  total: number;
}

export function computeAverageRates(models: ModelItem[]): AverageRates {
  if (models.length === 0) {
    return {
      input: DEFAULT_RATES.input,
      cached: DEFAULT_RATES.cached,
      output: DEFAULT_RATES.output,
      total: DEFAULT_RATES.input,
    };
  }

  let total_cost = 0;
  let total_tokens = 0;

  let total_input_tokens = 0;
  let total_input_cost = 0;

  let total_cached_tokens = 0;
  let total_cached_cost = 0;

  let total_output_tokens = 0;
  let total_output_cost = 0;

  for (const m of models) {
    const rates = getModelRates(m.model || m.agent);
    const cost_in = m.input_tokens * rates.input;
    const cost_cached = m.cached_tokens * rates.cached;
    const cost_out = m.output_tokens * rates.output;

    total_input_tokens += m.input_tokens;
    total_input_cost += cost_in;

    total_cached_tokens += m.cached_tokens;
    total_cached_cost += cost_cached;

    total_output_tokens += m.output_tokens;
    total_output_cost += cost_out;

    total_cost += cost_in + cost_cached + cost_out;
    total_tokens += m.input_tokens + m.cached_tokens + m.output_tokens;
  }

  return {
    input: total_input_tokens > 0 ? total_input_cost / total_input_tokens : DEFAULT_RATES.input,
    cached: total_cached_tokens > 0 ? total_cached_cost / total_cached_tokens : DEFAULT_RATES.cached,
    output: total_output_tokens > 0 ? total_output_cost / total_output_tokens : DEFAULT_RATES.output,
    total: total_tokens > 0 ? total_cost / total_tokens : DEFAULT_RATES.input,
  };
}
