// 笔记 24 验证：Discord 输出格式化（表格 → 对齐 ASCII 代码块 / 指令标签剥离 / 围栏感知分块）
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
  chunkDiscordText,
  DISCORD_TEXT_CHUNK_LIMIT,
} from '../src/dispatch/markdown-tables.ts';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

// 1. 表格 → 对齐 ASCII 代码块（openclaw tableMode "code"）
{
  const md = ['| 名称 | 值 |', '| --- | --- |', '| a | 1 |', '| bbb | 22 |'].join('\n');
  const out = convertMarkdownTables(md);
  // openclaw 语义：列宽 = max(表头/所有行文本长度)；dashCount = max(3, 列宽)
  const expected = [
    '\`\`\`',
    '| 名称  | 值  |',
    '| --- | --- |',
    '| a   | 1  |',
    '| bbb | 22 |',
    '\`\`\`',
  ].join('\n');
  assert(out === expected, '表格 → 对齐 ASCII 代码块（列宽对齐）');
}

// 2. 无表格内容原样返回
{
  const text = '普通 markdown **加粗** 和 \`code\`';
  assert(convertMarkdownTables(text) === text, '无表格 → 原样返回');
}

// 3. 表格 + 正文混合：只转换表格块，其他保留
{
  const md = ['开头文字', '| a | b |', '| - | - |', '| 1 | 2 |', '结尾文字'].join('\n');
  const out = convertMarkdownTables(md);
  assert(out.includes('开头文字') && out.includes('结尾文字') && out.includes('\`\`\`'), '混合内容：正文保留 + 表格转换');
}

// 4. mode off：不转换
{
  const md = ['| a | b |', '| - | - |'].join('\n');
  assert(convertMarkdownTables(md, 'off') === md, 'mode off 原样');
}

// 5. 空/无输入
{
  assert(convertMarkdownTables('') === '', '空输入');
}

// 6. stripInlineDirectiveTagsForDelivery：剥 [[audio_as_voice]] / [[reply_to:xxx]]
{
  const text = '看这个 [[audio_as_voice]] 和 [[reply_to:msg123]] 标签';
  const { text: stripped, changed } = stripInlineDirectiveTagsForDelivery(text);
  assert(!stripped.includes('[[audio_as_voice]]') && !stripped.includes('[[reply_to:msg123]]'), '指令标签剥离');
  assert(changed === true, 'changed 标志');
  assert(stripInlineDirectiveTagsForDelivery('普通文本').changed === false, '无标签 → changed=false');
}

// 7. chunkDiscordText：2000 上限
{
  const text = 'x'.repeat(2500);
  const chunks = chunkDiscordText(text);
  assert(chunks.length === 2 && chunks[0].length <= DISCORD_TEXT_CHUNK_LIMIT, '超长文本分块（≤2000）');
}

// 8. 围栏内分块
{
  const fenceText = ['\`\`\`js', ...Array(500).fill('line'), '\`\`\`'].join('\n');
  const chunks = chunkDiscordText(fenceText, 500);
  assert(chunks.length > 1, '长代码块分多块');
  assert(chunks.every((c) => c.length <= 500), '每块 ≤ 500');
}

// 9. 短文本单块
{
  assert(chunkDiscordText('短文本').length === 1, '短文本单块');
}

console.log(`\nmarkdown-tables tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
