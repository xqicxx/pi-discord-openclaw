// F2 验证：reasoning-lane（笔记 02）
import {
  splitTelegramReasoningText,
  extractThinkingFromTaggedStreamOutsideCode,
  isPartialReasoningTagPrefix,
  createTelegramReasoningStepState,
  renderReasoningText,
} from '../src/reasoning/reasoning-lane.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. 非 reasoning → 整段 answer
{
  const r = splitTelegramReasoningText('hello there', false);
  assert(r.answerText === 'hello there' && r.reasoningText === undefined, '非 reasoning → answerText');
}

// 2. 带 <think> 标签 → 提取为 🧠 reasoning
{
  const r = splitTelegramReasoningText('Let me think.<think>需要检查配置</think>Now answer.', true);
  assert((r.reasoningText ?? '').includes('🧠'), '提取 thinking → 🧠 前缀');
  assert((r.reasoningText ?? '').includes('需要检查配置'), 'thinking 内容保留');
}

// 3. 已是 🧠 消息 → 原样
{
  const r = splitTelegramReasoningText('🧠 _already_', true);
  assert(r.reasoningText === '🧠 _already_', '已是 🧠 → 原样');
}

// 4. "Thinking" 头 → 重写为 🧠
{
  const r = splitTelegramReasoningText('Thinking\n\n_body_', true);
  assert(r.reasoningText === '🧠 _body_', 'Thinking 头 → 🧠 重写');
}

// 5. 部分标签前缀 → 等待更多
{
  assert(isPartialReasoningTagPrefix('<think') === true, '<think 是部分前缀');
  assert(isPartialReasoningTagPrefix('hello') === false, '普通文本不是前缀');
  const r = splitTelegramReasoningText('<think', true);
  assert(r.reasoningText === undefined && r.answerText === undefined, '部分前缀 → 等待');
}

// 6. extractThinking 提取（代码块内标签跳过）
{
  const t = extractThinkingFromTaggedStreamOutsideCode('a<think>inner</think>b');
  assert(t === 'inner', '提取标签内文本');
}

// 7. 状态机：hinted → buffer → take
{
  const st = createTelegramReasoningStepState();
  st.noteReasoningHint();
  assert(st.shouldBufferFinalAnswer() === true, 'hinted 后可缓冲最终回答');
  st.bufferFinalAnswer({ text: 'final' });
  const taken = st.takeBufferedFinalAnswer();
  assert(taken?.text === 'final', 'take 缓冲回答');
  st.resetForNextStep();
  assert(st.shouldBufferFinalAnswer() === false, 'reset 后不可缓冲');
}

// 8. 渲染风格
{
  assert(renderReasoningText('think', 'emoji-italic') === '🧠 _think_', 'emoji-italic 渲染');
  assert(renderReasoningText('think', 'italic') === '_think_', 'italic 渲染');
  assert(renderReasoningText('think', 'hidden') === '', 'hidden 渲染');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
