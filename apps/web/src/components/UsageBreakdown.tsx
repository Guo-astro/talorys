import type { UsageCounters, UsageReport } from "@talorys/shared";

/** Estimates carry little precision, so show two or three significant digits. */
function formatEstimate(value: number | null, currency = false): string {
  if (value === null) return "—";
  if (currency) {
    if (value > 0 && value < 0.0001) return "<$0.0001";
    return `$${value >= 0.01
      ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value.toLocaleString(undefined, { maximumSignificantDigits: 2 })}`;
  }
  if (value > 0 && value < 0.01) return "<0.01";
  return value >= 100
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

/** Reported count first; estimated and legacy parts only when present, e.g. "39,527 + 23 est.". */
function formatTokens(reported: number, estimated: number, legacy: number): string {
  const parts = [reported.toLocaleString()];
  if (estimated > 0) parts.push(`${estimated.toLocaleString()} est.`);
  if (legacy > 0) parts.push(`${legacy.toLocaleString()} legacy`);
  return parts.join(" + ");
}

export function UsageBreakdown({ counters, compact = false }: { counters: UsageCounters; compact?: boolean }) {
  const legacy = counters.input_tokens_legacy + counters.output_tokens_legacy;
  const partial = counters.unpriced_calls > 0 || legacy > 0;
  const cost: [string, string] = [`Est. cost${partial ? " · partial" : ""}`, formatEstimate(counters.cost_usd_estimate, true)];
  const rows: [string, string][] = compact ? [
    ["Tokens", formatTokens(
      counters.input_tokens_reported + counters.output_tokens_reported,
      counters.input_tokens_estimated + counters.output_tokens_estimated,
      legacy,
    )],
    cost,
    ["Embeddings", counters.embedding_requests.toLocaleString()],
  ] : [
    ["Input tokens", formatTokens(counters.input_tokens_reported, counters.input_tokens_estimated, counters.input_tokens_legacy)],
    ["Output tokens", formatTokens(counters.output_tokens_reported, counters.output_tokens_estimated, counters.output_tokens_legacy)],
    [`Est. Neurons${partial ? " · partial" : ""}`, formatEstimate(counters.neurons_estimate)],
    cost,
    ["Embedding requests", counters.embedding_requests.toLocaleString()],
  ];
  if (counters.mock_calls > 0) rows.push(["Mock calls", counters.mock_calls.toLocaleString()]);

  const coverage = [counters.priced_calls === 0 ? "No priced calls yet" : `${counters.priced_calls.toLocaleString()} priced calls`];
  if (counters.unpriced_calls > 0) coverage.push(`${counters.unpriced_calls.toLocaleString()} unpriced (unknown model)`);
  if (legacy > 0) coverage.push("legacy tokens unpriced");
  if (counters.mock_calls > 0) coverage.push("mock calls free");

  return <div>
    <dl className="space-y-2 text-xs text-fg-muted">
      {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-3">
        <dt>{label}</dt><dd className="shrink-0 tabular-nums text-fg">{value}</dd>
      </div>)}
    </dl>
    {/* The compact popover links to Settings, which carries this note. */}
    {!compact && <p className="mt-3 text-xs leading-5 text-fg-subtle">{coverage.join(" · ")}</p>}
  </div>;
}

export function UsagePricingNote({ data }: { data: UsageReport }) {
  return <p className="text-xs leading-5 text-fg-subtle">
    {data.note} Rates from <a href={data.pricing.source_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Workers AI pricing</a> as of {data.pricing.as_of}: ${data.pricing.usd_per_1000_neurons.toLocaleString(undefined, { maximumFractionDigits: 8 })} per 1,000 Neurons.
  </p>;
}
