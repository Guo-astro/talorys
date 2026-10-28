import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { GITHUB_URL, type McpAuthType, type McpServerInfo, type McpServerStatus, type McpToolInfo, type McpToolPolicy } from "@talorys/shared";
import { ChevronDown, ChevronRight, LogIn, Plug, RefreshCw } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, ErrorNotice, Input, Label, Select, Spinner, Switch } from "./ui";
import { useToast } from "../hooks/toast";
import { keys, useApiMutation, useMcpServers, useMcpTools } from "../hooks/queries";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

const DOCS_URL = `${GITHUB_URL}/blob/main/docs/mcp.md`;

const STATUS: Record<McpServerStatus, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting", tone: "neutral" },
  auth_required: { label: "Needs authentication", tone: "warning" },
  disconnected: { label: "Disconnected", tone: "neutral" },
  disabled: { label: "Off", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

const AUTO_WARNING =
  "Runs without asking. Choose this only for tools that just read data: Talorys can't check what a tool really does, so this trusts the server.";

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** Opens a server's sign-in page. Only https pages are followed (plain http only for a local dev server). */
function openSignIn(url: string) {
  const target = new URL(url);
  const localDev = target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (target.protocol === "https:" || localDev) window.location.assign(target.href);
}

const AUTH_LABEL: Record<McpAuthType, string> = { none: "No authentication", bearer: "Bearer token", oauth: "Signs in with OAuth" };

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Settings → Integrations: remote MCP servers and which of their tools Talorys may use. */
export function McpServersCard() {
  const overview = useMcpServers();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const data = overview.data;
  const servers = data?.servers ?? [];

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">MCP servers</h2>
      <Card>
        <div className="divide-y divide-border">
          {overview.error ? (
            <div className="px-5 py-4">
              <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
            </div>
          ) : !data ? null : !data.enabled ? (
            <Row label="MCP servers are turned off" hint="This deployment sets TALORYS_MCP=off. Everything else in Talorys works as usual." />
          ) : (
            <>
              <Row
                label="Connect tools and services to extend what Talorys can do."
                hint={
                  <>
                    MCP servers are run by third parties, or by you. When Talorys uses one of their tools, it sends that tool's inputs to the
                    server, outside your Cloudflare account. New tools start off, and you choose which ones Talorys may use.{" "}
                    <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      How MCP servers work
                    </a>
                  </>
                }
              >
                {!adding && (
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plug className="h-4 w-4" /> Add MCP server
                  </Button>
                )}
              </Row>
              {adding && (
                <AddServerForm
                  credentialsAvailable={data.credentials_available}
                  onDone={(server) => {
                    setAdding(false);
                    if (server) setOpen(server.id);
                  }}
                />
              )}
              {servers.length === 0 && !adding && <p className="px-5 py-4 text-sm text-fg-subtle">No MCP servers yet.</p>}
              {servers.map((s) => (
                <ServerRow
                  key={s.id}
                  server={s}
                  maxTools={data.max_tools}
                  credentialsAvailable={data.credentials_available}
                  open={open === s.id}
                  onToggle={() => setOpen(open === s.id ? null : s.id)}
                />
              ))}
            </>
          )}
        </div>
      </Card>
    </section>
  );
}

function AddServerForm({ credentialsAvailable, onDone }: { credentialsAvailable: boolean; onDone: (server: McpServerInfo | null) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<McpAuthType>("none");
  const [token, setToken] = useState("");
  const create = useApiMutation(
    (input: { name: string; url: string; auth_type: McpAuthType; token?: string }) => api<{ server: McpServerInfo }>("/mcp/servers", { method: "POST", body: input }),
    {
      invalidate: [keys.mcpServers],
      success: (r) =>
        r.server.status === "connected" ? `Connected to ${r.server.name}` : r.server.authorize_url ? `Opening ${r.server.name}'s sign-in page` : `Saved ${r.server.name}, but it isn't connected yet`,
      onSuccess: (r) => {
        onDone(r.server);
        if (r.server.authorize_url) openSignIn(r.server.authorize_url);
      },
    },
  );
  const needsToken = auth === "bearer";
  const blocked = auth !== "none" && !credentialsAvailable;
  const ready = name.trim() && url.trim() && (!needsToken || token.trim()) && !blocked;
  return (
    <form
      className="space-y-3 bg-subtle px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate({ name: name.trim(), url: url.trim(), auth_type: auth, ...(needsToken ? { token: token.trim() } : {}) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="mcp-name">Name</Label>
          <Input id="mcp-name" value={name} maxLength={64} placeholder="e.g. Docs search" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="mcp-auth">Authentication</Label>
          <Select id="mcp-auth" value={auth} onChange={(e) => setAuth(e.target.value as McpAuthType)}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="oauth">OAuth (sign in)</option>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="mcp-url" hint="The server's Streamable HTTP endpoint, starting with https://">
          MCP server URL
        </Label>
        <Input id="mcp-url" type="url" inputMode="url" value={url} maxLength={2048} placeholder="https://example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
      </div>
      {needsToken && (
        <div>
          <Label htmlFor="mcp-token" hint="Stored encrypted. It is never shown again, and never sent to the AI.">
            Bearer token
          </Label>
          <Input id="mcp-token" type="password" autoComplete="off" value={token} maxLength={4096} onChange={(e) => setToken(e.target.value)} />
        </div>
      )}
      {auth === "oauth" && !blocked && (
        <p className="text-xs leading-5 text-fg-subtle">
          After you choose Connect, Talorys opens the server's sign-in page. Approve access there and you'll come back here. The server must support
          OAuth sign-in for new apps (dynamic client registration).
        </p>
      )}
      {blocked && (
        <p className="text-xs leading-5 text-warning">
          Credential storage isn't set up on this deployment. Run <code>npx create-talorys update</code> to add it, or use a server without authentication.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={create.isPending} disabled={!ready}>
          Connect
        </Button>
      </div>
    </form>
  );
}

function ServerRow({
  server,
  maxTools,
  credentialsAvailable,
  open,
  onToggle,
}: {
  server: McpServerInfo;
  maxTools: number;
  credentialsAvailable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [token, setToken] = useState("");
  const status = STATUS[server.status];
  const invalidate = [keys.mcpServers, keys.mcpTools(server.id)] as const;
  const connect = useApiMutation(() => api<{ server: McpServerInfo }>(`/mcp/servers/${server.id}/connect`, { method: "POST", body: {} }), {
    invalidate,
    success: (r) => (r.server.status === "connected" ? `Reconnected to ${r.server.name}` : `Couldn't connect to ${r.server.name}`),
  });
  const update = useApiMutation(
    (patch: { enabled?: boolean; token?: string }) => api<{ server: McpServerInfo }>(`/mcp/servers/${server.id}`, { method: "PATCH", body: patch }),
    { invalidate, onSuccess: () => setToken("") },
  );
  const remove = useApiMutation(() => api(`/mcp/servers/${server.id}`, { method: "DELETE" }), {
    invalidate: [keys.mcpServers],
    success: `Removed ${server.name}`,
    onSuccess: () => setConfirmRemove(false),
  });
  const auth = server.auth_type === "bearer" ? (server.has_credential ? "Bearer token set" : "Bearer token missing") : AUTH_LABEL[server.auth_type];
  return (
    <div>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 items-start gap-2 text-left">
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />}
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {server.name} <Badge tone={status.tone}>{status.label}</Badge>
              {server.review_count > 0 && <Badge tone="warning">{server.review_count} to review</Badge>}
            </span>
            <span className="mt-0.5 block break-words text-xs leading-5 text-fg-subtle">
              {host(server.url)} · {server.enabled_tool_count} of {server.tool_count} tools on · {auth}
            </span>
            {server.error && <span className={cn("mt-0.5 block text-xs leading-5", server.status === "connected" ? "text-fg-muted" : "text-warning")}>{server.error}</span>}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {server.authorize_url && server.enabled && (
            <Button size="sm" onClick={() => openSignIn(server.authorize_url!)}>
              <LogIn className="h-3.5 w-3.5" /> Sign in
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onToggle}>
            Manage
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Reconnect ${server.name}`} loading={connect.isPending} disabled={!server.enabled} onClick={() => connect.mutate(undefined)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Switch checked={server.enabled} onChange={(on) => update.mutate({ enabled: on })} label={`Use ${server.name}`} disabled={update.isPending} />
        </div>
      </div>
      {open && (
        <div className="space-y-4 border-t border-border bg-subtle px-5 py-4">
          <ToolList server={server} maxTools={maxTools} />
          {server.auth_type === "bearer" && (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) update.mutate({ token: token.trim() });
              }}
            >
              <div className="flex-1">
                <Label htmlFor={`mcp-token-${server.id}`} hint="Replaces the stored token and reconnects.">
                  {server.has_credential ? "Replace bearer token" : "Add bearer token"}
                </Label>
                <Input id={`mcp-token-${server.id}`} type="password" autoComplete="off" value={token} maxLength={4096} disabled={!credentialsAvailable} onChange={(e) => setToken(e.target.value)} />
              </div>
              <Button type="submit" variant="outline" size="sm" loading={update.isPending} disabled={!token.trim() || !credentialsAvailable}>
                Save token
              </Button>
            </form>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="text-danger" onClick={() => setConfirmRemove(true)}>
              Remove server
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${server.name}?`}
        message="Talorys forgets this server, its token and your tool choices. Requests waiting for approval can no longer run."
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
      />
    </div>
  );
}

function hintText(tool: McpToolInfo): string | null {
  const { readOnly, destructive } = tool.hints;
  if (destructive) return "The server says this tool can delete or overwrite data.";
  if (readOnly) return "The server says this tool only reads data (not verified).";
  return null;
}

function ToolList({ server, maxTools }: { server: McpServerInfo; maxTools: number }) {
  const tools = useMcpTools(server.id);
  const save = useApiMutation(
    ({ tool, patch }: { tool: McpToolInfo; patch: { enabled?: boolean; policy?: McpToolPolicy } }) =>
      api<{ tool: McpToolInfo }>(`/mcp/servers/${server.id}/tools/${tool.id}`, { method: "PATCH", body: patch }),
    { invalidate: [keys.mcpServers, keys.mcpTools(server.id)] },
  );
  if (tools.error) return <ErrorNotice error={tools.error} onRetry={() => void tools.refetch()} />;
  if (!tools.data) return null;
  if (tools.data.length === 0) {
    return <p className="text-sm text-fg-subtle">{server.status === "connected" ? "This server has no tools." : "Connect to see this server's tools."}</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-fg-subtle">
        Turn on only the tools you want Talorys to use. Up to {maxTools} tools can be on across all servers. MCP tools are never used by scheduled
        automations.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {tools.data.map((t) => {
          const hint = hintText(t);
          const usable = t.status === "available";
          return (
            <li key={t.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 break-all text-sm font-medium">
                    {t.title ?? t.name}
                    {t.title && <span className="font-mono text-xs font-normal text-fg-subtle">{t.name}</span>}
                    {t.status === "removed" && <Badge>No longer offered</Badge>}
                    {t.status === "invalid" && <Badge tone="danger">Can't be used</Badge>}
                    {t.needs_review && <Badge tone="warning">Changed, review again</Badge>}
                  </p>
                  {t.description && <p className="mt-0.5 line-clamp-3 break-words text-xs leading-5 text-fg-muted">{t.description}</p>}
                  {t.invalid_reason && <p className="mt-0.5 text-xs leading-5 text-danger">{t.invalid_reason}</p>}
                  {t.needs_review && (
                    <p className="mt-0.5 text-xs leading-5 text-warning">Its description or inputs changed, so Talorys stopped using it. Turn it on again to approve the new version.</p>
                  )}
                  {hint && <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</p>}
                </div>
                <Switch
                  checked={t.enabled && !t.needs_review}
                  onChange={(on) => save.mutate({ tool: t, patch: { enabled: on } })}
                  label={`Use ${t.name}`}
                  disabled={save.isPending || (!usable && !t.enabled)}
                />
              </div>
              {t.enabled && usable && (
                <div className="space-y-1">
                  <Select
                    aria-label={`When Talorys uses ${t.name}`}
                    value={t.policy}
                    className="sm:w-64"
                    disabled={save.isPending}
                    onChange={(e) => save.mutate({ tool: t, patch: { policy: e.target.value as McpToolPolicy } })}
                  >
                    <option value="approve">Ask me every time</option>
                    <option value="auto">Run without asking</option>
                  </Select>
                  {t.policy === "auto" && <p className="text-xs leading-5 text-warning">{AUTO_WARNING}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Where an MCP server's OAuth sign-in returns. It forwards the code and state to the backend with
 * the owner's session (the cross-site redirect itself carries no session cookie), then goes back
 * to Settings.
 */
export function McpOAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const sent = useRef(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const state = params.get("state");
    if (!state) {
      setError(new Error("This page finishes signing in to an MCP server. Start from Settings → Integrations."));
      return;
    }
    const pick = (k: string) => {
      const v = params.get(k);
      return v ? { [k]: v } : {};
    };
    api<{ server: McpServerInfo }>("/mcp/oauth/callback", { method: "POST", body: { state, ...pick("code"), ...pick("iss"), ...pick("error") } })
      .then(async ({ server }) => {
        await qc.invalidateQueries({ queryKey: keys.mcpServers });
        if (server.status === "connected") toast(`Signed in to ${server.name}`);
        else toast(server.error ?? `Couldn't sign in to ${server.name}`, "error");
        navigate("/settings?tab=Integrations", { replace: true });
      })
      .catch(setError);
  }, [params, navigate, toast, qc]);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      {error ? (
        <div className="space-y-4">
          <ErrorNotice error={error} />
          <Link to="/settings?tab=Integrations" className="text-sm text-accent hover:underline">
            Back to Integrations
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-sm text-fg-muted">
          <Spinner />
          Finishing sign-in…
        </div>
      )}
    </div>
  );
}
