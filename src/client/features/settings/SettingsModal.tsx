/**
 * 设置页。版式照 DeepSeek Harness：左边一列分区，右边是"标题 + 说明 + 字段"。
 *
 * 分五区：账户（版本与数据目录）、通用（外观、语言）、模型、Agent、MCP。
 * 这里只负责装内容与排版；各区自己的数据与动作仍在原面板里
 * （ModelPanel / AgentList），避免同一份逻辑两处实现。
 */

import { t, type Locale } from "../../locale/index.js";
import type { ThemeMode } from "../../theme/mode.js";
import { AgentList, AgentRefreshButton } from "../agents/AgentList.js";
import { McpPanel } from "../mcp/McpPanel.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import { AccountPanel } from "../account/AccountPanel.js";
import { ModelPanel } from "../models/ModelPanel.js";
import styles from "./settings.module.css";

export type SettingsSection = "account" | "general" | "models" | "agents" | "mcp";

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  labelKey: Parameters<typeof t>[0];
  descKey: Parameters<typeof t>[0];
}> = [
  { id: "account", labelKey: "settings.account", descKey: "settings.accountDesc" },
  { id: "general", labelKey: "settings.general", descKey: "settings.generalDesc" },
  { id: "models", labelKey: "settings.models", descKey: "settings.modelsDesc" },
  { id: "agents", labelKey: "settings.agents", descKey: "settings.agentsDesc" },
  { id: "mcp", labelKey: "settings.mcp", descKey: "settings.mcpDesc" },
];

export interface SettingsModalProps {
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly theme: ThemeMode;
  readonly onTheme: (theme: ThemeMode) => void;
  readonly locale: Locale;
  readonly onLocale: (locale: Locale) => void;
}

export function SettingsModal({
  section,
  onSection,
  theme,
  onTheme,
  locale,
  onLocale,
}: SettingsModalProps): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const current: (typeof SECTIONS)[number] = SECTIONS.find((item) => item.id === section) ?? {
    id: "account",
    labelKey: "settings.account",
    descKey: "settings.accountDesc",
  };
  return (
    <div className={styles.layout}>
      <nav className={styles.nav} aria-label={t("settings.title")}>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              item.id === section ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem
            }
            aria-current={item.id === section ? "page" : undefined}
            onClick={() => onSection(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <section className={styles.pane}>
        <div className={styles.paneHead}>
          <div>
            <h3 className={styles.heading}>{t(current.labelKey)}</h3>
            <p className={styles.desc}>{t(current.descKey)}</p>
          </div>
          {section === "agents" ? <AgentRefreshButton /> : null}
        </div>
        {state.error !== null ? (
          <div className={styles.error} role="alert">
            <span>{state.error}</span>
            <button type="button" onClick={() => store.dismissError()}>{t("action.close")}</button>
          </div>
        ) : null}
        {section === "account" ? <AccountPanel /> : null}
        {section === "general" ? (
          <GeneralSection theme={theme} onTheme={onTheme} locale={locale} onLocale={onLocale} />
        ) : null}
        {section === "models" ? <ModelPanel /> : null}
        {section === "agents" ? <AgentList /> : null}
        {section === "mcp" ? <McpPanel /> : null}
      </section>
    </div>
  );
}

function GeneralSection({
  theme,
  onTheme,
  locale,
  onLocale,
}: Pick<SettingsModalProps, "theme" | "onTheme" | "locale" | "onLocale">): JSX.Element {
  return (
    <>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("settings.theme")}</span>
        <div className={styles.segmented}>
          <button
            type="button"
            className={theme === "light" ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
            aria-pressed={theme === "light"}
            onClick={() => onTheme("light")}
          >
            {t("settings.themeLight")}
          </button>
          <button
            type="button"
            className={theme === "dark" ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
            aria-pressed={theme === "dark"}
            onClick={() => onTheme("dark")}
          >
            {t("settings.themeDark")}
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("settings.language")}</span>
        <div className={styles.segmented}>
          <button
            type="button"
            className={locale === "zh-CN" ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
            aria-pressed={locale === "zh-CN"}
            onClick={() => onLocale("zh-CN")}
          >
            {t("settings.langZh")}
          </button>
          <button
            type="button"
            className={locale === "en" ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
            aria-pressed={locale === "en"}
            onClick={() => onLocale("en")}
          >
            {t("settings.langEn")}
          </button>
        </div>
      </div>
    </>
  );
}
