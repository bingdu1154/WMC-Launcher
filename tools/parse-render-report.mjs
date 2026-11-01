#!/usr/bin/env node
/**
 * WMC 面板 · 渲染校验报告解析
 * ---------------------------------------------------------------------------
 * 与 tools/verify-render.html 配套：把 headless Chromium 的 --dump-dom 输出
 * 从标准输入读进来，抽取页面里嵌的 JSON 报告并打印人话版结论。
 *
 * 用法：
 *   msedge --headless=new --dump-dom file:///.../verify-render.html | node tools/parse-render-report.mjs
 */
let html = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { html += chunk; });
process.stdin.on('end', () => {
  const match = html.match(/WMC_RENDER_REPORT_BEGIN([\s\S]*?)WMC_RENDER_REPORT_END/);
  if (!match) {
    const title = (html.match(/<title>(.*?)<\/title>/) || [])[1] || '(无标题)';
    console.error('❌ 页面里没有找到校验报告块（说明脚本没跑完或抛错）。title =', title);
    const out = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (out) console.error('页面输出：', out[1].slice(0, 400));
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch (error) {
    console.error('❌ 报告 JSON 解析失败：', error.message);
    process.exit(1);
  }

  const { summary, checks, errors, bridgeMode } = report;
  const failures = checks.filter((c) => !c.pass);

  console.log(`渲染校验：共 ${summary.total} 项，通过 ${summary.passed}，失败 ${summary.failed}`);
  console.log(`数据来源：${bridgeMode === 'ipc' ? '主进程 IPC' : '内置模拟数据'}`);
  console.log('');

  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? `  →  ${c.detail}` : ''}`);
  }

  if (errors.length) {
    console.log('\n运行期错误 / 警告：');
    for (const e of errors.slice(0, 6)) console.log('  ⚠ ' + String(e).slice(0, 200));
  }

  console.log('');
  if (failures.length) {
    console.log(`结论：不通过（${failures.length} 项）`);
    process.exit(1);
  }
  console.log('结论：全部通过 ✅');
});