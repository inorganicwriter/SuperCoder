/**
 * Agent 面板「模型」下拉的选项构造。
 *
 * 两类来源必须分开呈现，因为它们的归属不同：
 * - Agent 原生模型：Agent 自己在 ACP 会话里声明，SuperCoder 不保存、也不能编辑；
 * - SuperCoder 档案：来自「模型管理」，派活时由宿主注入密钥与 baseURL。
 *
 * 组内标签带 provider 前缀。原生清单里同名很常见（DeepSeek 与 DeepSeek Account
 * 各有一个 DeepSeek-V41-Flash），而下拉折叠时只显示标签，不去重就分辨不出是哪条路线。
 *
 * `hint` 只表达“会用到哪一个”（与保存值相同的那一项）。Agent 报的 currentValue
 * 是它自己的默认值，不产生任何行为，标出来只会让下拉里出现两个“当前”。
 */

import type { ModelProfileView } from "../../../shared/domain/model.js";
import type { ProviderModel } from "../../../shared/domain/provider.js";
import type { SelectOption } from "../../render/Select.js";

export interface ModelOptionTexts {
  /** 原生模型那一组的标题。 */
  readonly nativeGroup: string;
  /** SuperCoder 档案那一组的标题。 */
  readonly profileGroup: string;
  /** 与保存值一致的那一项右侧的提示。 */
  readonly inUse: string;
  /** 保存值不在当前清单里时的前缀。 */
  readonly saved: string;
}

export interface ModelOptionInput {
  readonly placeholder: string;
  readonly native: readonly ProviderModel[];
  readonly profiles: readonly ModelProfileView[];
  /** 已经保存的选择；`""` 表示使用 Agent 默认。 */
  readonly selected: string;
  readonly texts: ModelOptionTexts;
}

const SEPARATOR = " · ";

export function buildModelOptions(input: ModelOptionInput): SelectOption[] {
  const { placeholder, native, profiles, selected, texts } = input;
  const sorted = [...native].sort((left, right) =>
    (left.provider ?? "").localeCompare(right.provider ?? "") || left.label.localeCompare(right.label));
  const options: SelectOption[] = [{ value: "", label: placeholder }];
  const known = new Set<string>();
  for (const item of sorted) known.add(item.id);
  for (const item of profiles) known.add(`profile:${item.id}`);
  // 清单还没读回来、或 Agent 已经不再声明这个模型时，如实说“已保存的是它”，
  // 不能把内部 ID 直接当标签显示。
  if (selected !== "" && !known.has(selected)) {
    options.push({ value: selected, label: `${texts.saved}${SEPARATOR}${describeSelection(selected)}` });
  }
  for (const item of sorted) {
    const qualified = item.provider === undefined || item.provider === "" ? item.label : `${item.provider}${SEPARATOR}${item.label}`;
    options.push({
      value: item.id,
      label: qualified,
      group: texts.nativeGroup,
      ...(item.id === selected ? { hint: texts.inUse } : {}),
    });
  }
  for (const item of profiles) {
    options.push({
      value: `profile:${item.id}`,
      label: item.label,
      group: texts.profileGroup,
      hint: `profile:${item.id}` === selected ? texts.inUse : hostOf(item.baseUrl),
    });
  }
  return options;
}

/** DeepSeek Harness 的原生选择是 JSON 数组字符串：`["tai","deepseek-v4.1-flash"]`。 */
function describeSelection(selected: string): string {
  if (selected.startsWith("profile:")) return selected.slice("profile:".length);
  const pair = /^\["([^"]+)","([^"]+)"\]$/.exec(selected);
  return pair === null ? selected : `${pair[1]}${SEPARATOR}${pair[2]}`;
}

/** 档案的右侧提示用域名：同一 provider 下多个档案时，仅凭标签分不开。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
