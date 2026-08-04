// Bot token masking — ported from openclaw security (CHANGELOG #99428/#103861).
// 日志/错误信息中隐藏 Telegram bot token，防止泄露。
// openclaw: "Telegram timeout logs now hide bot tokens embedded in Bot API paths" +
//          "bot tokens now remain masked even when they cross internal boundaries".

const TOKEN_RE = /\d{8,10}:[A-Za-z0-9_-]{30,}/g;

/** 把完整 bot token 替换为脱敏形式（保留前 6 位用于区分）。 */
export function maskTelegramToken(text: string): string {
  if (!text) return text;
  return text.replace(TOKEN_RE, (match) => {
    const head = match.slice(0, 6);
    return `${head}***`;
  });
}

/** 脱敏 Bot API URL 中的 token（如 .../bot<TOKEN>/sendMessage）。 */
export function maskBotTokenInUrl(url: string): string {
  if (!url) return url;
  return url.replace(/(\/bot)\d{8,10}:[A-Za-z0-9_-]{30,}/g, "$1***");
}

/** 日志包装器：自动脱敏 token。 */
export function maskLog(message: string): string {
  return maskTelegramToken(maskBotTokenInUrl(message));
}
