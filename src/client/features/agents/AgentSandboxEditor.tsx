import { useEffect, useState } from "react";
import type { ProviderStatus } from "../../../shared/domain/provider.js";
import {
  AGENT_ALLOWLIST_PRESETS,
  AgentSandboxProfileSchema,
  DEFAULT_AGENT_SANDBOX_PROFILE,
  ENV_KEY_PATTERN,
  isSensitiveEnvKey,
  type AgentSandboxProfile,
  type DockerMount,
  type DockerNetworkIsolation,
  type NetworkMode,
  type SandboxTestResult,
  type WorkspaceIsolation,
} from "../../../shared/domain/sandbox.js";
import { t } from "../../locale/index.js";
import { Select } from "../../render/Select.js";
import { useStore } from "../../render/SessionProvider.js";
import styles from "./agents.module.css";

interface DraftState {
  mode: NetworkMode;
  proxyUrl: string;
  noProxyText: string;
  caCertPath: string;
  allowlistText: string;
  denylistText: string;
  isolation: WorkspaceIsolation;
  envText: string;
  secretKeys: string[];
  unsetText: string;
  prependPathText: string;
  isolatedHome: boolean;
  backendKind: "process" | "docker";
  dockerImage: string;
  dockerNetwork: DockerNetworkIsolation;
  dockerMemory: string;
  dockerCpus: string;
  dockerReadOnlyRoot: boolean;
  dockerMountsText: string;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function formatMounts(mounts: readonly DockerMount[]): string {
  return mounts.map((mount) => `${mount.host}:${mount.container}:${mount.readOnly ? "ro" : "rw"}`).join("\n");
}

function parseMounts(raw: string): { ok: true; mounts: DockerMount[] } | { ok: false; message: string } {
  const mounts: DockerMount[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    let body = line;
    let readOnly = true;
    const modeMatch = /:(ro|rw)$/i.exec(body);
    if (modeMatch !== null) {
      readOnly = modeMatch[1]!.toLowerCase() === "ro";
      body = body.slice(0, modeMatch.index);
    }
    const splitAt = body.lastIndexOf(":/");
    const windowsDriveOnly = splitAt === 1 && /^[A-Za-z]:\//.test(body);
    if (splitAt <= 0 || windowsDriveOnly) {
      return { ok: false, message: `${t("agent.sandboxInvalid")} (${line})` };
    }
    const host = body.slice(0, splitAt).trim();
    const container = body.slice(splitAt + 1).trim();
    if (host === "" || !container.startsWith("/")) {
      return { ok: false, message: `${t("agent.sandboxInvalid")} (${line})` };
    }
    mounts.push({ host, container, readOnly });
  }
  return { ok: true, mounts };
}

function toDraft(profile: AgentSandboxProfile): DraftState {
  const docker = profile.backend.docker;
  return {
    mode: profile.network.mode,
    proxyUrl: profile.network.proxyUrl ?? "",
    noProxyText: profile.network.noProxy.join(", "),
    caCertPath: profile.network.caCertPath ?? "",
    allowlistText: profile.network.allowlist.join(", "),
    denylistText: profile.network.denylist.join(", "),
    isolation: profile.workspace.isolation,
    envText: Object.entries(profile.env.set)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    secretKeys: [...profile.env.secretKeys],
    unsetText: profile.env.unset.join(", "),
    prependPathText: profile.env.prependPath.join("\n"),
    isolatedHome: profile.env.isolatedHome,
    backendKind: profile.backend.kind,
    dockerImage: docker?.image ?? "",
    dockerNetwork: docker?.networkIsolation ?? "proxy-only",
    dockerMemory: docker?.memoryLimit ?? "",
    dockerCpus: docker?.cpuLimit === undefined ? "" : String(docker.cpuLimit),
    dockerReadOnlyRoot: docker?.readOnlyRoot ?? false,
    dockerMountsText: docker ? formatMounts(docker.extraMounts) : "",
  };
}

function defaultTestUrl(agentId: string): string {
  if (agentId === "codex") return "https://api.openai.com";
  if (agentId === "claude-code") return "https://api.anthropic.com";
  if (agentId === "deepseek-harness") return "https://api.deepseek.com";
  if (agentId === "kimi-code") return "https://api.moonshot.cn";
  return "https://example.com";
}

function buildProfileFromDraft(
  draft: DraftState,
  removedSecrets: readonly string[],
): { ok: true; sandbox: AgentSandboxProfile; secretValues: Record<string, string> } | { ok: false; message: string } {
  const plainSet: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  for (const key of removedSecrets) {
    secretValues[key] = "";
  }

  for (const rawLine of draft.envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return { ok: false, message: `${t("agent.sandboxInvalid")} (${line})` };
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!ENV_KEY_PATTERN.test(key)) {
      return { ok: false, message: `${t("agent.sandboxInvalid")} (${key})` };
    }
    if (isSensitiveEnvKey(key)) {
      secretValues[key] = value;
    } else {
      plainSet[key] = value;
    }
  }

  let backend: AgentSandboxProfile["backend"] = { kind: "process" };
  if (draft.backendKind === "docker") {
    const parsedMounts = parseMounts(draft.dockerMountsText);
    if (!parsedMounts.ok) return parsedMounts;
    let cpuLimit: number | undefined;
    if (draft.dockerCpus.trim() !== "") {
      const value = Number(draft.dockerCpus.trim());
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, message: `${t("agent.sandboxInvalid")} (${draft.dockerCpus})` };
      }
      cpuLimit = value;
    }
    backend = {
      kind: "docker",
      docker: {
        image: draft.dockerImage.trim(),
        networkIsolation: draft.dockerNetwork,
        ...(draft.dockerMemory.trim() === "" ? {} : { memoryLimit: draft.dockerMemory.trim() }),
        ...(cpuLimit === undefined ? {} : { cpuLimit }),
        readOnlyRoot: draft.dockerReadOnlyRoot,
        extraMounts: parsedMounts.mounts,
      },
    };
  }

  const candidate = {
    network: {
      mode: draft.mode,
      ...(draft.mode === "proxy" && draft.proxyUrl.trim() !== "" ? { proxyUrl: draft.proxyUrl.trim() } : {}),
      noProxy: draft.mode !== "offline" ? splitList(draft.noProxyText) : [],
      ...(draft.mode !== "offline" && draft.caCertPath.trim() !== "" ? { caCertPath: draft.caCertPath.trim() } : {}),
      allowlist: splitList(draft.allowlistText),
      denylist: splitList(draft.denylistText),
    },
    env: {
      set: plainSet,
      secretKeys: draft.secretKeys,
      unset: splitList(draft.unsetText),
      prependPath: draft.prependPathText
        .split(/[\r\n;]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
      isolatedHome: draft.isolatedHome,
    },
    workspace: {
      isolation: draft.isolation,
    },
    backend,
  };

  const parsed = AgentSandboxProfileSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? t("agent.sandboxInvalid"),
    };
  }
  return { ok: true, sandbox: parsed.data, secretValues };
}

export function AgentSandboxEditor({ agent }: { readonly agent: ProviderStatus }): JSX.Element {
  const store = useStore();
  const savedProfile = agent.sandbox ?? DEFAULT_AGENT_SANDBOX_PROFILE;
  const savedKey = JSON.stringify(savedProfile);
  const capabilities = agent.sandboxCapabilities ?? { env: true, network: true, worktree: true, docker: false };
  const processUnsupported = !capabilities.network && !capabilities.env;
  const dockerAvailable = capabilities.docker === true;
  const presetDomains = AGENT_ALLOWLIST_PRESETS[agent.id];

  const [draft, setDraft] = useState<DraftState>(() => toDraft(savedProfile));
  const [removedSecrets, setRemovedSecrets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedFlag, setSavedFlag] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState<string>(() => defaultTestUrl(agent.id));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SandboxTestResult | null>(null);

  useEffect(() => {
    setDraft(toDraft(JSON.parse(savedKey) as AgentSandboxProfile));
    setRemovedSecrets([]);
    setLocalError(null);
  }, [savedKey]);

  const handleSave = async (): Promise<void> => {
    setLocalError(null);
    setSavedFlag(false);
    const built = buildProfileFromDraft(draft, removedSecrets);
    if (!built.ok) {
      setLocalError(built.message);
      return;
    }
    setSaving(true);
    const ok = await store.setAgentSandbox(agent.id, built.sandbox, built.secretValues);
    setSaving(false);
    if (ok) {
      setRemovedSecrets([]);
      setSavedFlag(true);
    }
  };

  const handleReset = async (): Promise<void> => {
    setLocalError(null);
    setSavedFlag(false);
    setTestResult(null);
    const clearSecrets: Record<string, string> = {};
    for (const key of savedProfile.env.secretKeys) clearSecrets[key] = "";
    setSaving(true);
    const ok = await store.setAgentSandbox(agent.id, DEFAULT_AGENT_SANDBOX_PROFILE, clearSecrets);
    setSaving(false);
    if (ok) {
      setDraft(toDraft(DEFAULT_AGENT_SANDBOX_PROFILE));
      setRemovedSecrets([]);
      setSavedFlag(true);
    }
  };

  const handleTest = async (): Promise<void> => {
    setLocalError(null);
    const built = buildProfileFromDraft(draft, []);
    if (!built.ok) {
      setLocalError(built.message);
      return;
    }
    setTesting(true);
    const result = await store.testAgentSandbox(agent.id, testUrl.trim(), built.sandbox);
    setTesting(false);
    if (result !== null) setTestResult(result);
  };

  return (
    <div className={styles.sandboxBox}>
      <div className={styles.sandboxHeader}>
        <span className={styles.sandboxTitle}>{t("agent.sandboxTitle")}</span>
      </div>

      {processUnsupported ? (
        <p className={styles.hint}>{capabilities.note ?? t("agent.sandboxUnsupported")}</p>
      ) : null}

      <div className={styles.fields}>
        <div className={styles.field}>
          <span>{t("agent.networkMode")}</span>
          <Select
            value={draft.mode}
            disabled={processUnsupported}
            ariaLabel={t("agent.networkMode")}
            options={[
              { value: "inherit", label: t("agent.netInherit") },
              { value: "direct", label: t("agent.netDirect") },
              { value: "proxy", label: t("agent.netProxy") },
              { value: "offline", label: t("agent.netOffline") },
            ]}
            onChange={(next) => {
              setSavedFlag(false);
              setDraft((prev) => ({ ...prev, mode: next as NetworkMode }));
            }}
          />
        </div>

        <div className={styles.field}>
          <span>{t("agent.workspaceIsolation")}</span>
          <Select
            value={draft.isolation}
            disabled={!capabilities.worktree}
            ariaLabel={t("agent.workspaceIsolation")}
            options={[
              { value: "shared", label: t("agent.isolationShared") },
              { value: "worktree", label: t("agent.isolationWorktree") },
            ]}
            onChange={(next) => {
              setSavedFlag(false);
              setDraft((prev) => ({ ...prev, isolation: next as WorkspaceIsolation }));
            }}
          />
        </div>
      </div>

      {!processUnsupported && draft.mode === "proxy" ? (
        <label className={styles.field}>
          <span>{t("agent.proxyUrl")}</span>
          <input
            type="text"
            className={styles.input}
            value={draft.proxyUrl}
            placeholder={t("agent.proxyUrlPlaceholder")}
            onChange={(event) => {
              setSavedFlag(false);
              setDraft((prev) => ({ ...prev, proxyUrl: event.target.value }));
            }}
          />
        </label>
      ) : null}

      {!processUnsupported && draft.mode !== "offline" ? (
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>{t("agent.noProxy")}</span>
            <input
              type="text"
              className={styles.input}
              value={draft.noProxyText}
              placeholder={t("agent.noProxyPlaceholder")}
              onChange={(event) => {
                setSavedFlag(false);
                setDraft((prev) => ({ ...prev, noProxyText: event.target.value }));
              }}
            />
          </label>
          <label className={styles.field}>
            <span>{t("agent.caCertPath")}</span>
            <input
              type="text"
              className={styles.input}
              value={draft.caCertPath}
              placeholder={t("agent.caCertPlaceholder")}
              onChange={(event) => {
                setSavedFlag(false);
                setDraft((prev) => ({ ...prev, caCertPath: event.target.value }));
              }}
            />
          </label>
        </div>
      ) : null}

      {!processUnsupported ? (
        <>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldHead}>
                {t("agent.allowlist")}
                {presetDomains !== undefined ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      setSavedFlag(false);
                      const merged = [...new Set([...splitList(draft.allowlistText), ...presetDomains])];
                      setDraft((prev) => ({ ...prev, allowlistText: merged.join(", ") }));
                    }}
                  >
                    {t("agent.allowlistPreset")}
                  </button>
                ) : null}
              </span>
              <input
                type="text"
                className={styles.input}
                value={draft.allowlistText}
                placeholder={t("agent.allowlistPlaceholder")}
                onChange={(event) => {
                  setSavedFlag(false);
                  setDraft((prev) => ({ ...prev, allowlistText: event.target.value }));
                }}
              />
            </label>
            <label className={styles.field}>
              <span>{t("agent.denylist")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.denylistText}
                placeholder={t("agent.denylistPlaceholder")}
                onChange={(event) => {
                  setSavedFlag(false);
                  setDraft((prev) => ({ ...prev, denylistText: event.target.value }));
                }}
              />
            </label>
          </div>

          <label className={styles.field}>
            <span>{t("agent.envVars")}</span>
            <textarea
              className={styles.textarea}
              rows={3}
              value={draft.envText}
              placeholder={t("agent.envVarsPlaceholder")}
              onChange={(event) => {
                setSavedFlag(false);
                setDraft((prev) => ({ ...prev, envText: event.target.value }));
              }}
            />
            <span className={styles.hint}>{t("agent.envVarsHint")}</span>
          </label>

          {draft.secretKeys.length > 0 ? (
            <div className={styles.field}>
              <span>{t("agent.envSecrets")}</span>
              <div className={styles.chipRow}>
                {draft.secretKeys.map((key) => (
                  <span key={key} className={styles.secretChip}>
                    <code>{key}</code>
                    <button
                      type="button"
                      className={styles.chipRemove}
                      aria-label={`${t("action.remove")} ${key}`}
                      onClick={() => {
                        setSavedFlag(false);
                        setRemovedSecrets((prev) => (prev.includes(key) ? prev : [...prev, key]));
                        setDraft((prev) => ({
                          ...prev,
                          secretKeys: prev.secretKeys.filter((item) => item !== key),
                        }));
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.fields}>
            <label className={styles.field}>
              <span>{t("agent.envUnset")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.unsetText}
                placeholder={t("agent.envUnsetPlaceholder")}
                onChange={(event) => {
                  setSavedFlag(false);
                  setDraft((prev) => ({ ...prev, unsetText: event.target.value }));
                }}
              />
            </label>
            <label className={styles.field}>
              <span>{t("agent.envPath")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.prependPathText}
                placeholder={t("agent.envPathPlaceholder")}
                onChange={(event) => {
                  setSavedFlag(false);
                  setDraft((prev) => ({ ...prev, prependPathText: event.target.value }));
                }}
              />
            </label>
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={draft.isolatedHome}
              onChange={(event) => {
                setSavedFlag(false);
                setDraft((prev) => ({ ...prev, isolatedHome: event.target.checked }));
              }}
            />
            <span>{t("agent.isolatedHome")}</span>
          </label>

          <div className={styles.fields}>
            <div className={styles.field}>
              <span>{t("agent.backendLabel")}</span>
              <Select
                value={draft.backendKind}
                disabled={processUnsupported}
                ariaLabel={t("agent.backendLabel")}
                options={[
                  { value: "process", label: t("agent.backendProcess") },
                  ...(dockerAvailable || draft.backendKind === "docker"
                    ? [{ value: "docker", label: t("agent.backendDocker") }]
                    : []),
                ]}
                onChange={(next) => {
                  setSavedFlag(false);
                  setDraft((prev) => ({ ...prev, backendKind: next as "process" | "docker" }));
                }}
              />
            </div>

            {draft.backendKind === "docker" ? (
              <div className={styles.field}>
                <span>{t("agent.dockerNetwork")}</span>
                <Select
                  value={draft.dockerNetwork}
                  ariaLabel={t("agent.dockerNetwork")}
                  options={[
                    { value: "proxy-only", label: t("agent.dockerNetProxyOnly") },
                    { value: "bridge", label: t("agent.dockerNetBridge") },
                    { value: "none", label: t("agent.dockerNetNone") },
                  ]}
                  onChange={(next) => {
                    setSavedFlag(false);
                    setDraft((prev) => ({ ...prev, dockerNetwork: next as DockerNetworkIsolation }));
                  }}
                />
              </div>
            ) : null}
          </div>

          {!dockerAvailable ? <p className={styles.hint}>{t("agent.dockerUnavailable")}</p> : null}

          {draft.backendKind === "docker" ? (
            <>
              <label className={styles.field}>
                <span>{t("agent.dockerImage")}</span>
                <input
                  type="text"
                  className={styles.input}
                  value={draft.dockerImage}
                  placeholder={t("agent.dockerImagePlaceholder")}
                  onChange={(event) => {
                    setSavedFlag(false);
                    setDraft((prev) => ({ ...prev, dockerImage: event.target.value }));
                  }}
                />
              </label>

              <div className={styles.fields}>
                <label className={styles.field}>
                  <span>{t("agent.dockerMemory")}</span>
                  <input
                    type="text"
                    className={styles.input}
                    value={draft.dockerMemory}
                    placeholder={t("agent.dockerMemoryPlaceholder")}
                    onChange={(event) => {
                      setSavedFlag(false);
                      setDraft((prev) => ({ ...prev, dockerMemory: event.target.value }));
                    }}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t("agent.dockerCpus")}</span>
                  <input
                    type="text"
                    className={styles.input}
                    value={draft.dockerCpus}
                    placeholder={t("agent.dockerCpusPlaceholder")}
                    onChange={(event) => {
                      setSavedFlag(false);
                      setDraft((prev) => ({ ...prev, dockerCpus: event.target.value }));
                    }}
                  />
                </label>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={draft.dockerReadOnlyRoot}
                  onChange={(event) => {
                    setSavedFlag(false);
                    setDraft((prev) => ({ ...prev, dockerReadOnlyRoot: event.target.checked }));
                  }}
                />
                <span>{t("agent.dockerReadOnlyRoot")}</span>
              </label>

              <label className={styles.field}>
                <span>{t("agent.dockerMounts")}</span>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={draft.dockerMountsText}
                  placeholder={t("agent.dockerMountsPlaceholder")}
                  onChange={(event) => {
                    setSavedFlag(false);
                    setDraft((prev) => ({ ...prev, dockerMountsText: event.target.value }));
                  }}
                />
                <span className={styles.hint}>{t("agent.dockerHint")}</span>
              </label>
            </>
          ) : null}

          <div className={styles.testRow}>
            <input
              type="text"
              className={styles.input}
              aria-label={t("agent.sandboxTestUrl")}
              value={testUrl}
              onChange={(event) => setTestUrl(event.target.value)}
            />
            <button type="button" disabled={testing} onClick={() => void handleTest()}>
              {testing ? t("agent.sandboxTesting") : t("agent.sandboxTestBtn")}
            </button>
          </div>
          {testResult !== null ? (
            <p className={testResult.ok ? styles.testOk : styles.testFail}>{testResult.message}</p>
          ) : null}
        </>
      ) : null}

      {localError !== null ? <p className={styles.testFail}>{localError}</p> : null}

      <div className={styles.sandboxActions}>
        <button type="button" disabled={saving} onClick={() => void handleSave()}>
          {saving ? t("agent.sandboxSaving") : t("agent.sandboxSave")}
        </button>
        <button type="button" disabled={saving} onClick={() => void handleReset()}>
          {t("agent.sandboxReset")}
        </button>
        {savedFlag ? <span className={styles.savedNote}>{t("agent.sandboxSaved")}</span> : null}
      </div>
    </div>
  );
}
