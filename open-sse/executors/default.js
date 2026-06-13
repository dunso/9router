import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { buildClineHeaders } from "../../src/shared/utils/clineAuth.js";
import { getCachedClaudeHeaders } from "../utils/claudeHeaderCache.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
    // Generate conversation ID once per executor instance
    this._conversationId = this._generateUUID();
  }

  // Generate UUID without dashes (compact)
  _generateCompactId() {
    if (typeof crypto !== "undefined" && crypto.randomBytes) {
      return crypto.randomBytes(16).toString("hex");
    }
    // Fallback for environments without crypto
    let str = "";
    for (let i = 0; i < 32; i++) {
      str += Math.floor(Math.random() * 16).toString(16);
    }
    return str;
  }

  // Generate standard UUID
  _generateUUID() {
    if (typeof crypto !== "undefined" && crypto.randomBytes) {
      const bytes = crypto.randomBytes(16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    // Fallback
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  transformRequest(model, body) {
    const transformed = this.applyJsonSchemaFallback(body);

    if (transformed && typeof transformed === "object") {
      if (this.provider === "cerebras" || this.provider === "mistral") {
        delete transformed.client_metadata;
      }
    }

    return injectReasoningContent({ provider: this.provider, model, body: transformed });
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
    const sys = messages.find(m => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    // CodeBuddy: use base_url from credentials (may be SSO domain)
    if (this.provider === "codebuddy") {
      const psd = credentials?.providerSpecificData || {};
      // Use stored base_url, or construct from domain
      let baseUrl = psd.base_url;
      if (!baseUrl && psd.domain) {
        baseUrl = `https://${psd.domain}`;
      }
      if (!baseUrl) {
        baseUrl = "https://copilot.tencent.com";
      }
      // Remove trailing slash and add path
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/v2/chat/completions`;
    }
    switch (this.provider) {
      case "claude":
      case "glm":
      case "kimi":
      case "minimax":
      case "minimax-cn":
        return `${this.config.baseUrl}?beta=true`;
      case "kimi-coding":
        return `${this.config.baseUrl}?beta=true`;
      case "gemini":
        return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default: {
        const url = this.config.baseUrl;
        if (url?.includes("{accountId}")) {
          const accountId = credentials?.providerSpecificData?.accountId;
          if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
          return url.replace("{accountId}", accountId);
        }
        return url;
      }
    }
  }

  buildHeaders(credentials, stream = true, body = null) {
    const headers = { "Content-Type": "application/json", ...this.config.headers };

    switch (this.provider) {
      case "gemini":
        credentials.apiKey ? headers["x-goog-api-key"] = credentials.apiKey : headers["Authorization"] = `Bearer ${credentials.accessToken}`;
        break;
      case "claude": {
        // Overlay live cached headers from real Claude Code client over static defaults.
        // Static headers (Title-Case) remain as cold-start fallback.
        const cached = getCachedClaudeHeaders();
        if (cached) {
          // Remove Title-Case static keys that conflict with incoming lowercase cached keys
          for (const lcKey of Object.keys(cached)) {
            // Build the Title-Case equivalent: "anthropic-version" → "Anthropic-Version"
            const titleKey = lcKey.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());

            // Special handling for Anthropic-Beta to preserve required flags like OAuth
            if (lcKey === "anthropic-beta") {
              const staticBetaStr = headers[titleKey] || headers[lcKey] || "";
              const staticFlags = new Set(staticBetaStr.split(",").map(f => f.trim()).filter(Boolean));
              const cachedFlags = new Set(cached[lcKey].split(",").map(f => f.trim()).filter(Boolean));

              // Merge all static flags (which contain oauth, thinking, etc) into the cached ones
              for (const flag of staticFlags) {
                cachedFlags.add(flag);
              }

              cached[lcKey] = Array.from(cachedFlags).join(",");
            }

            if (titleKey !== lcKey && headers[titleKey] !== undefined) {
              delete headers[titleKey];
            }
          }
          Object.assign(headers, cached);
        }
        credentials.apiKey
          ? (headers["x-api-key"] = credentials.apiKey)
          : (headers["Authorization"] = `Bearer ${credentials.accessToken}`);
        break;
      }
      case "glm":
      case "kimi":
      case "minimax":
      case "minimax-cn":
      case "kimi-coding":
        headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
        if (this.provider === "kimi-coding") Object.assign(headers, buildKimiHeaders());
        break;
      default:
        if (this.provider?.startsWith?.("anthropic-compatible-")) {
          if (credentials.apiKey) {
            headers["x-api-key"] = credentials.apiKey;
          } else if (credentials.accessToken) {
            headers["Authorization"] = `Bearer ${credentials.accessToken}`;
          }
          if (!headers["anthropic-version"]) {
            headers["anthropic-version"] = "2023-06-01";
          }
        } else if (this.provider === "gitlab") {
          // GitLab Duo uses Bearer token (PAT with ai_features scope, or OAuth access token)
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        } else if (this.provider === "codebuddy") {
          const accessToken = credentials.apiKey || credentials.accessToken;
          
          // Get providerSpecificData (matching claude-api-proxy structure)
          const psd = credentials.providerSpecificData || {};
          
          // Get userId from providerSpecificData (matching claude-api-proxy: user_id field)
          const userId = psd.user_id || psd.userId || "";
          
          // Get base_url from providerSpecificData (matching claude-api-proxy)
          // For SSO tokens, we need to use the SSO domain as baseUrl
          let baseUrl = psd.base_url || credentials.providerSpecificData?.baseUrl || "https://copilot.tencent.com";
          
          // Check if this is an SSO token (from sso.codebuddy.cn)
          // If so, we need to use the SSO domain for API calls
          if (psd.domain && psd.domain.includes("sso.codebuddy.cn")) {
            baseUrl = `https://${psd.domain}`;
          }
          
          const host = new URL(baseUrl).host;
          
          // Get enterprise_id for enterprise accounts
          // Try from stored data first, then extract from JWT
          let enterpriseId = psd.enterprise_id || "";
          
          // Extract enterprise_id from JWT if not stored
          if (!enterpriseId && accessToken) {
            try {
              const parts = accessToken.split(".");
              if (parts.length === 3) {
                const padded = parts[1] + "===".slice(0, (4 - parts[1].length % 4) % 4);
                const jwtPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
                if (jwtPayload.realm_access?.roles) {
                  const entMemberRole = jwtPayload.realm_access.roles.find(r => r.startsWith('ent-member:'));
                  if (entMemberRole) {
                    enterpriseId = entMemberRole.split(':')[1];
                    console.log(`[CodeBuddy] Extracted enterpriseId from JWT: ${enterpriseId}`);
                  }
                }
              }
            } catch {}
          }
          
          // Check if this is a personal host (no enterprise headers needed)
          const personalHosts = ['copilot.tencent.com', 'www.codebuddy.ai'];
          const isPersonal = personalHosts.includes(host);
          
          // Generate conversation IDs for cache key
          const conversationId = this._conversationId || this._generateId();
          const conversationRequestId = this._generateCompactId();
          const conversationMessageId = this._generateCompactId();
          const requestId = this._generateCompactId();
          
          // DEBUG: Log CodeBuddy request details
          console.log(`[CodeBuddy] Request URL: ${baseUrl}/v2/chat/completions`);
          console.log(`[CodeBuddy] host: ${host}`);
          console.log(`[CodeBuddy] userId: ${userId}`);
          console.log(`[CodeBuddy] enterpriseId: ${enterpriseId || '(personal account)'}`);
          console.log(`[CodeBuddy] isPersonal: ${isPersonal}`);
          console.log(`[CodeBuddy] conversationId: ${conversationId}`);
          console.log(`[CodeBuddy] body model: ${body.model}`);
          console.log(`[CodeBuddy] body keys: ${Object.keys(body).join(", ")}`);
          console.log(`[CodeBuddy] body.stream: ${body.stream}`);
          // Ensure stream is true for CodeBuddy (required)
          if (body && typeof body === 'object' && body.stream !== true) {
            body.stream = true;
            console.log(`[CodeBuddy] Set body.stream = true`);
          }
          
          // Build CodeBuddy headers (matching claude-api-proxy exactly)
          headers["Host"] = host;
          headers["Accept"] = "application/json";
          headers["Content-Type"] = "application/json";
          headers["Authorization"] = `Bearer ${accessToken}`;
          headers["X-Requested-With"] = "XMLHttpRequest";
          // Use the domain from JWT or the host
          headers["X-Domain"] = psd.domain || host;
          headers["User-Agent"] = `CLI/2.93.1 CodeBuddy/2.93.1`;
          headers["X-Product"] = "SaaS";
          headers["X-User-Id"] = userId;
          headers["X-Session-ID"] = userId;
          headers["X-Agent-Intent"] = "craft";
          headers["X-IDE-Type"] = "CLI";
          headers["X-IDE-Name"] = "CLI";
          headers["X-IDE-Version"] = "2.93.1";
          headers["x-stainless-arch"] = process?.arch === "arm64" ? "arm64" : "amd64";
          headers["x-stainless-lang"] = "js";
          headers["x-stainless-os"] = process?.platform || "unknown";
          headers["x-stainless-package-version"] = "6.25.0";
          headers["x-stainless-retry-count"] = "0";
          headers["x-stainless-runtime"] = "node";
          headers["x-stainless-runtime-version"] = process?.version || "unknown";
          
          // Enterprise headers (for enterprise/SO accounts)
          if (!isPersonal && enterpriseId) {
            headers["X-Enterprise-Id"] = enterpriseId;
            headers["X-Tenant-Id"] = enterpriseId;
            console.log(`[CodeBuddy] Adding enterprise headers: X-Enterprise-Id=${enterpriseId}`);
            if (psd.department_info) {
              headers["X-Department-Info"] = psd.department_info;
            }
          }
          
          // Conversation tracking headers (required for cache)
          headers["X-Conversation-ID"] = conversationId;
          headers["X-Conversation-Request-ID"] = conversationRequestId;
          headers["X-Conversation-Message-ID"] = conversationMessageId;
          headers["X-Request-ID"] = requestId;
          
          // Add prompt_cache_key for better caching (body is passed as parameter)
          if (body && typeof body === 'object' && !body.prompt_cache_key && conversationId) {
            body.prompt_cache_key = conversationId;
          }
        } else if (this.provider === "kilocode") {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
          if (credentials.providerSpecificData?.orgId) {
            headers["X-Kilocode-OrganizationID"] = credentials.providerSpecificData.orgId;
          }
        } else if (this.provider === "cline") {
          Object.assign(headers, buildClineHeaders(credentials.apiKey || credentials.accessToken));
        } else if (this.config?.format === "claude") {
          // Generic claude-format provider (e.g. agentrouter): x-api-key + anthropic-version
          headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
          if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        }
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        // Some third-party Anthropic-compatible gateways require Bearer auth in
        // addition to x-api-key. Send both (x-api-key already set above) so
        // gateways that read either header succeed.
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        // Strip claude-code-20250219 from Anthropic-Beta / anthropic-beta
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map(s => s.trim())
              .filter(f => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) {
              headers[betaKey] = filtered;
            } else {
              delete headers[betaKey];
            }
          }
        }
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refreshers = {
      claude: () => this.refreshWithJSON(OAUTH_ENDPOINTS.anthropic.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.claude.clientId }, proxyOptions),
      codex: () => this.refreshWithForm(OAUTH_ENDPOINTS.openai.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.codex.clientId, scope: "openid profile email offline_access" }, proxyOptions),
      qwen: () => this.refreshWithForm(OAUTH_ENDPOINTS.qwen.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.qwen.clientId }, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshGoogle(credentials.refreshToken, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      cline: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      "kimi-coding": () => this.refreshKimiCoding(credentials.refreshToken, proxyOptions),
      kilocode: () => this.refreshKilocode(credentials.refreshToken, proxyOptions)
    };

    const refresher = refreshers[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || body.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams(params)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || params.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Authorization": `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: PROVIDERS.iflow.clientId, client_secret: PROVIDERS.iflow.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshGoogle(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kiro-cli/1.0.0" },
      body: JSON.stringify({ refreshToken })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || refreshToken, expiresIn: tokens.expiresIn };
  }

  async refreshCline(refreshToken, proxyOptions = null) {
    console.log('[DEBUG] Refreshing Cline token, refreshToken length:', refreshToken?.length);
    const response = await proxyAwareFetch("https://api.cline.bot/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" })
    }, proxyOptions);
    console.log('[DEBUG] Cline refresh response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.log('[DEBUG] Cline refresh error:', errorText);
      return null;
    }
    const payload = await response.json();
    console.log('[DEBUG] Cline refresh payload:', JSON.stringify(payload).substring(0, 200));
    const data = payload?.data || payload;
    const expiresAtIso = data?.expiresAt;
    const expiresIn = expiresAtIso ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)) : undefined;
    console.log('[DEBUG] Cline refresh success, expiresIn:', expiresIn);
    return { accessToken: data?.accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
  }

  async refreshKimiCoding(refreshToken, proxyOptions = null) {
    const kimiHeaders = buildKimiHeaders();
    const response = await proxyAwareFetch("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        ...kimiHeaders
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKilocode(refreshToken, proxyOptions = null) {
    // Kilocode uses device code flow, no refresh token support
    return null;
  }
}

export default DefaultExecutor;
