import type { Usage } from "./provider";

/** Published token-based rates only; never infer a rate for an unknown model. */
export const WORKERS_AI_PRICING = {
  as_of: "2026-10-09",
  source_url: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  usd_per_1000_neurons: 0.011,
} as const;

// Neurons per million input, output, and (where separately priced) cached input tokens.
// Keep model IDs exact: aliases and unsupported tasks are not interchangeable rates.
const RATES: Readonly<Record<string, readonly [number, number, number?]>> = {
  "@cf/meta/llama-3.2-1b-instruct": [2457, 18252],
  "@cf/meta/llama-3.2-3b-instruct": [4625, 30475],
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": [4119, 34868],
  "@cf/meta/llama-3.2-11b-vision-instruct": [4410, 61493],
  "@cf/meta/llama-3.1-70b-instruct-fp8-fast": [26668, 204805],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": [45170, 443756],
  "@cf/deepseek-ai/deepseek-v4-flash-0731": [40000, 120000, 1273],
  "@cf/deepseek-ai/deepseek-v4-pro-0813": [120000, 360000, 4000],
  "@cf/mistral/mistral-7b-instruct-v0.1": [10000, 17300],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [31876, 50488],
  "@cf/meta/llama-3.1-8b-instruct": [25608, 75147],
  "@cf/meta/llama-3.1-8b-instruct-fp8": [13778, 26128],
  "@cf/meta/llama-3.1-8b-instruct-awq": [11161, 24215],
  "@cf/meta/llama-3-8b-instruct": [25608, 75147],
  "@cf/meta/llama-3-8b-instruct-awq": [11161, 24215],
  "@cf/meta/llama-2-7b-chat-fp16": [50505, 606061],
  "@cf/meta/llama-guard-3-8b": [44003, 2730],
  "@cf/meta/llama-4-scout-17b-16e-instruct": [24545, 77273],
  "@cf/google/gemma-3-12b-it": [31371, 50560],
  "@cf/qwen/qwq-32b": [60000, 90909],
  "@cf/qwen/qwen2.5-coder-32b-instruct": [60000, 90909],
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/qwen/qwen3.8-27b": [40909, 290909],
  "@cf/openai/gpt-oss-120b": [31818, 68182],
  "@cf/openai/gpt-oss-20b": [18182, 27273],
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it": [31876, 50488],
  "@cf/ibm-granite/granite-4.0-h-micro": [1542, 10158],
  "@cf/zai-org/glm-4.7-flash": [5500, 36400],
  "@cf/zai-org/glm-5.2": [127273, 400000, 23636],
  "@cf/zai-org/glm-5.3": [127273, 400000, 23636],
  "@cf/zai-org/glm-5.3-flash": [13636, 45455, 2727],
  "@cf/nvidia/nemotron-3-120b-a12b": [45455, 136364],
  "@cf/moonshotai/kimi-k2.5": [54545, 272727, 9091],
  "@cf/moonshotai/kimi-k2.6": [86364, 363636, 14545],
  "@cf/moonshotai/kimi-k2.7-code": [86364, 363636, 17273],
  "@cf/google/gemma-4-26b-a4b-it": [9091, 27273],
  "@cf/baai/bge-small-en-v1.5": [1841, 0],
  "@cf/baai/bge-base-en-v1.5": [6058, 0],
  "@cf/baai/bge-large-en-v1.5": [18582, 0],
  "@cf/baai/bge-m3": [1075, 0],
  "@cf/pfnet/plamo-embedding-1b": [1689, 0],
  "@cf/qwen/qwen3-embedding-0.6b": [1075, 0],
  "@cf/huggingface/distilbert-sst-2-int8": [2394, 0],
  "@cf/baai/bge-reranker-base": [283, 0],
  "@cf/meta/m2m100-1.2b": [31050, 31050],
  "@cf/ai4bharat/indictrans2-en-indic-1B": [31050, 31050],
  "@cf/moondream/moondream3.1-9B-A2B": [27273, 90909],
  "@cf/cloudflare/clef": [21818, 0],
  "@cf/cloudflare/clef-omni": [13636, 0],
  "@cf/cloudflare/clef-flash": [3455, 0],
};

export function estimateConsumption(usage: Usage): { neurons: number; costUsd: number } | null {
  if (!usage.billable || !Object.hasOwn(RATES, usage.model)) return null;
  const [inputRate, outputRate, cachedRate] = RATES[usage.model]!;
  const input = usage.inputTokens.reported + usage.inputTokens.estimated;
  const output = usage.outputTokens.reported + usage.outputTokens.estimated;
  const cached = usage.cachedInputTokens;
  // Without cache details, full input rate is a conservative estimate, not a billed cost.
  const neurons = ((input - cached) * inputRate + cached * (cachedRate ?? inputRate) + output * outputRate) / 1_000_000;
  return { neurons, costUsd: neurons * WORKERS_AI_PRICING.usd_per_1000_neurons / 1000 };
}
