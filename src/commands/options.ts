// Discord command options builder — 移植自 openclaw extensions/discord/src/monitor/native-command.options.ts
// （笔记 20/21）。纯函数、零依赖：CommandArgDefinition → Discord ApplicationCommandOption。
import type { ChatCommandDefinition } from "./registry.ts";

// Discord ApplicationCommandOptionType（discord-api-types v10 最小面）
export const ApplicationCommandOptionType = {
  Subcommand: 1,
  SubcommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11,
} as const;

// Discord 命令/选项描述长度上限（官方文档）
const DISCORD_COMMAND_DESCRIPTION_MAX = 100;
// Discord 静态 choices 上限（超出需 autocomplete；本项目命令全部 ≤25，静态即可）
const DISCORD_MAX_CHOICES = 25;

/** UTF-16 安全截断（不切断代理对；openclaw truncateUtf16Safe 同语义）。 */
export function truncateUtf16Safe(value: string, max: number): string {
  if (value.length <= max) return value;
  let result = "";
  for (const char of value) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

export function truncateDiscordCommandDescription(value: string): string {
  return truncateUtf16Safe(value, DISCORD_COMMAND_DESCRIPTION_MAX);
}

/** 解析静态 choices（string | {value,label} 统一为 Discord {name,value}）。 */
function resolveChoices(
  choices: Array<string | { value: string; label: string }> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (!choices || choices.length === 0) return undefined;
  return choices.slice(0, DISCORD_MAX_CHOICES).map((choice) =>
    typeof choice === "string"
      ? { name: choice, value: choice }
      : { name: choice.label, value: choice.value },
  );
}

/**
 * 构建 Discord 命令选项（openclaw buildDiscordCommandOptions 移植）。
 * String/Number/Boolean 类型映射 + 静态 choices。无参数返回 undefined。
 */
export function buildDiscordCommandOptions(
  command: ChatCommandDefinition,
): Array<{
  name: string;
  description: string;
  type: number;
  required: boolean;
  choices?: Array<{ name: string; value: string }>;
}> | undefined {
  const args = command.args;
  if (!args || args.length === 0) return undefined;
  return args.map((arg) => {
    const required = arg.required ?? false;
    const description = truncateDiscordCommandDescription(arg.description);
    if (arg.type === "number") {
      return { name: arg.name, description, type: ApplicationCommandOptionType.Number, required };
    }
    if (arg.type === "boolean") {
      return { name: arg.name, description, type: ApplicationCommandOptionType.Boolean, required };
    }
    const choices = resolveChoices(arg.choices);
    return {
      name: arg.name,
      description,
      type: ApplicationCommandOptionType.String,
      required,
      choices,
    };
  });
}
