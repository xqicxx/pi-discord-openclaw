// Assistant transcript prefix — ported from openclaw format-assistant-transcript.ts (对照遗漏 #8).
// 转录消息统一加 `Assistant:` 前缀（Discord Markdown code），与 openclaw 一致。

export const DISCORD_ASSISTANT_TRANSCRIPT_PREFIX = "`Assistant:` ";

/** 给转录文本加 Assistant 前缀（若尚无）。 */
export function protectTelegramAssistantTranscriptRoleHeaders(text: string): string {
  if (!text || text.startsWith(DISCORD_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return text;
  }
  return `${DISCORD_ASSISTANT_TRANSCRIPT_PREFIX}${text}`;
}
