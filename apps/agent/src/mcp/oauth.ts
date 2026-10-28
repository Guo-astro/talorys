import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { TALORYS_VERSION } from "@talorys/shared";

/** How long the owner has to finish signing in after Talorys sends them to the authorization server. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Everything Talorys keeps for one server's OAuth connection. It is stored only as AES-GCM
 * ciphertext in the server's `credential` column, like a bearer token, and never leaves the backend
 * except `authorize_url`, which the owner needs to sign in.
 */
export interface OAuthRecord {
  redirect_url?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  /** The pending sign-in: single use, expires after OAUTH_STATE_TTL_MS. */
  state?: string;
  state_expires?: string;
  authorize_url?: string;
}

export interface OAuthStore {
  load(): Promise<OAuthRecord>;
  save(patch: Partial<OAuthRecord>): Promise<void>;
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** `<server id>.<random>`: the id finds the server on the callback, the random part is the secret. */
export const oauthStateServerId = (state: string): string => state.split(".")[0] ?? "";

/** Equal-length comparison that doesn't stop at the first differing character. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The MCP SDK's OAuth client hooks, backed by the encrypted record. Talorys registers as a public
 * client (dynamic client registration, PKCE, no client secret). `redirectToAuthorization` only
 * records the URL: the owner opens it from Settings, never the agent.
 */
export class TalorysOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly serverId: string,
    readonly redirectUrl: string,
    private readonly store: OAuthStore,
    private readonly checkAuthorizeUrl: (url: URL) => void,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Talorys",
      client_uri: "https://github.com/rociiu/talorys",
      software_id: "talorys",
      software_version: TALORYS_VERSION,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    const state = `${this.serverId}.${randomToken()}`;
    await this.store.save({ state, state_expires: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString() });
    return state;
  }

  async clientInformation() {
    const { client, redirect_url } = await this.store.load();
    // A registration made for another redirect URL (the app moved to a new address) can't be used.
    return redirect_url === this.redirectUrl ? client : undefined;
  }

  async saveClientInformation(client: StoredOAuthClientInformation) {
    await this.store.save({ client, redirect_url: this.redirectUrl });
  }

  async tokens() {
    return (await this.store.load()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    await this.store.save({ tokens });
  }

  async redirectToAuthorization(url: URL) {
    this.checkAuthorizeUrl(url);
    await this.store.save({ authorize_url: url.href });
  }

  async saveCodeVerifier(verifier: string) {
    await this.store.save({ verifier });
  }

  async codeVerifier() {
    const { verifier } = await this.store.load();
    if (!verifier) throw new Error("No PKCE verifier is stored for this sign-in.");
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.store.save({ discovery });
  }

  async discoveryState() {
    return (await this.store.load()).discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const clear: Partial<OAuthRecord> = {};
    if (scope === "all" || scope === "client") clear.client = undefined;
    if (scope === "all" || scope === "tokens") clear.tokens = undefined;
    if (scope === "all" || scope === "verifier") clear.verifier = undefined;
    if (scope === "all" || scope === "discovery") clear.discovery = undefined;
    await this.store.save(clear);
  }
}
