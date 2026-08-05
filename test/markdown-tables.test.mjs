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


// 10. Issue #4 回归：表格代码块跨切分点 → 围栏整体保留（不产生孤立围栏）
{
  const F = '\`\`\`';
  const filler = Array(75).fill('- 前面是一些普通说明文字，占位用。').join('\n');
  const table = [
    '| 项目 | 状态 |',
    '|---|---|',
    '| 审查 workflow | ✅ 你原来的自写版恢复（手动触发，不费 Actions 额度） |',
    '| 模型 | ✅ \`gemini-2.5-flash\` → **\`gemini-3.6-flash\`**（2.5 已弃用；3.6 是 GA 工作马，更便宜质量更好） |',
    '| API key | ✅ 你原有的 Google key 继续用（GitHub Actions 在美国跑，**不受地区封锁**） |',
    '| 实测 | ✅ 17 秒完成 PR 审查，评论分级清晰（MAJOR/MINOR + 中英 verdict） |',
  ].join('\n');
  const tail = '\n\n## 日常用法\n\n' + F + 'bash\n# 手动审查指定 PR\ngh workflow run "Gemini PR Review" -f pr_number=<PR号>\n' + F;
  const reply = filler + '\n\n' + table + tail;
  const formatted = convertMarkdownTables(reply);
  assert(formatted.length > 1900, '前置：转换后文本超 1900（触发分块）');
  const chunks = chunkDiscordText(formatted, 1900);
  assert(chunks.length > 1, '前置：产生多块');
  const fenceOk = chunks.every((c) => (c.match(/\`\`\`/g) || []).length % 2 === 0);
  assert(fenceOk, '每块围栏数成对（表格代码块未被切断）');
  assert(!chunks.some((c) => c.includes('| API key') && !c.includes('| 项目')), '表格行不散落在缺表头的块里');
}

// 11. 非超长行不被切半（行完整保留）
{
  const lines = Array(30).fill('- 这是一行普通说明文字，用于验证行完整性。').join('\n');
  const chunks = chunkDiscordText(lines, 500);
  assert(chunks.length > 1, '前置：多块');
  assert(chunks.every((c) => c.split('\n').every((l) => l.startsWith('- 这是一行普通说明文字'))), '行未被从中间切断');
}

// 12. 未闭合围栏也整体保留
{
  const text = Array(600).fill('x').join('') + '\n\`\`\`js\ncode without close';
  const chunks = chunkDiscordText(text, 1900);
  assert(chunks[chunks.length - 1].includes('\`\`\`js'), '未闭合围栏块整体保留在最后一块');
}

console.log(`\nmarkdown-tables tests: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
