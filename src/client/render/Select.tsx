/**
 * 统一的下拉选择。替代原生 <select>：原生下拉展开后是系统样式，和其余界面对不上。
 *
 * - 触发按钮与输入框同高同边框；弹层与输入区的模型选择弹层同一套样式。
 * - 选项超过 12 个时出现筛选框（OpenCode 能报几百个模型）。
 * - Esc / 点外面关闭；方向键在选项间移动，回车选中。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./select.module.css";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** 右侧的弱化说明，例如"当前默认"。 */
  readonly hint?: string;
  /** 分组名；相邻同组的选项归在一个小标题下。 */
  readonly group?: string;
}

export interface SelectProps {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly filterPlaceholder?: string;
}

const FILTER_THRESHOLD = 12;

export function Select({ value, options, onChange, placeholder = "", disabled = false, ariaLabel, filterPlaceholder = "" }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<React.CSSProperties>({});
  const selected = options.find((option) => option.value === value);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? options : options.filter((option) => `${option.label} ${option.value} ${option.group ?? ""}`.toLowerCase().includes(q));
  }, [options, query]);

  // 弹层用 fixed 定位：设置页右栏是滚动容器，absolute 会被裁掉。下方放不下就往上开。
  const openPopover = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      const below = window.innerHeight - rect.bottom;
      const up = below < 260 && rect.top > below;
      setPlace({
        left: rect.left,
        width: Math.max(rect.width, 220),
        ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${String(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (option: SelectOption | undefined): void => {
    if (option === undefined) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") { event.stopPropagation(); setOpen(false); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(visible.length - 1, at + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(0, at - 1)); }
    if (event.key === "Enter") { event.preventDefault(); choose(visible[cursor]); }
  };

  return (
    <div className={styles.wrap} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        <span className={selected === undefined ? styles.placeholder : styles.value}>{selected?.label ?? placeholder}</span>
        <span className={styles.caret} aria-hidden="true" />
      </button>
      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.popover} style={place}>
            {options.length > FILTER_THRESHOLD ? (
              <input
                className={styles.filter}
                autoFocus
                value={query}
                placeholder={filterPlaceholder}
                onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
              />
            ) : null}
            <ul ref={listRef} className={styles.list} role="listbox" aria-label={ariaLabel}>
              {visible.map((option, index) => {
                const newGroup = option.group !== undefined && option.group !== visible[index - 1]?.group;
                return (
                  <li key={`${option.group ?? ""}:${option.value}`} role="presentation">
                    {newGroup ? <div className={styles.group}>{option.group}</div> : null}
                    <button
                      type="button"
                      role="option"
                      data-index={index}
                      aria-selected={option.value === value}
                      className={index === cursor ? `${styles.option} ${styles.optionActive}` : styles.option}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => choose(option)}
                    >
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.hint !== undefined ? <span className={styles.hint}>{option.hint}</span> : null}
                      {option.value === value ? <span className={styles.check} aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })}
              {visible.length === 0 ? <li className={styles.empty}>—</li> : null}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
