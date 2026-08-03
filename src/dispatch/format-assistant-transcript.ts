// Assistant transcript prefix — ported from openclaw format-assistant-transcript.ts (对照遗漏 #8).
// 转录消息统一加 <code>Assistant:</code> 前缀，与 openclaw 一致。

export const TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX = "<code>Assistant:</code> ";

/** 给转录文本加 Assistant 前缀（若尚无）。 */
export function protectTelegramAssistantTranscriptRoleHeaders(text: string): string {
  if (!text || text.startsWith(TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return text;
  }
  return `${TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX}${text}`;
}
