/**
 * 弹窗外壳：照 Python 版的 `.modal-overlay` + `.panel-card` 重画。
 *
 * 只有一个可访问性入口（Esc 关闭、点遮罩关闭、打开时把焦点送进去），
 * 具体内容由调用方塞进来 —— 弹窗和抽屉复用同一批面板组件。
 */

import { useEffect, useRef } from "react";
import { t } from "../locale/index.js";
import styles from "./modal.module.css";

export interface ModalProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  /** 宽一点的弹窗（模型注册表、MCP）用这个。 */
  readonly wide?: boolean;
}

export function Modal({ title, onClose, children, wide = false }: ModalProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        // 只有点在遮罩本身才关；点在卡片上冒泡上来的不算。
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={wide ? `${styles.panel} ${styles.panelWide}` : styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} aria-label={t("action.close")} onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" />
          </svg>
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
