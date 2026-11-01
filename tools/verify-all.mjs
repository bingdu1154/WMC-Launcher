#!/usr/bin/env node
/**
 * WMC 面板 · 一键验证
 * ---------------------------------------------------------------------------
 *   node tools/verify-all.mjs
 *   node tools/verify-all.mjs --render     # 只跑渲染校验
 *   node tools/verify-all.mjs --static     # 只跑静态自检
 *
 * 做两件事：
 *   1) 静态自检（无需浏览器）：tools/check-ui.mjs
 *   2) 渲染校验（需要本机 Chromium：Edge 或 Chrome）：
 *      用无头浏览器打开 tools/verify-render.html，把「计算样式/几何/动画」实测结果取回来
 *      与需求逐条比对，并把截图写到 .verify/ 供人工确认。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyStatic = args.includes('--static');
const onlyRender = args.includes('--render');

/* ---------------------------------------------------------------- 找 Chromium */
function findChromium() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

const toFileUrl = (rel) => 'file:///' + join(ROOT, rel).replace(/\\/g, '/').replace(/^\//, '');

function run(command, cmdArgs, opts = {}) {
  return spawnSync(command, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });
}

let failed = 0;

/* ---------------------------------------------------------------- 1) 静态自检 */
if (!onlyRender) {
  console.log('\n========== 1/2 静态自检（HTML/CSS/JS 一致性 + 纯逻辑） ==========\n');
  const result = run(process.execPath, [join(ROOT, 'tools/check-ui.mjs'), ...(args.includes('--verbose') ? ['--verbose'] : [])]);
  if (result.status !== 0) failed += 1;
}

/* ---------------------------------------------------------------- 2) 渲染校验 */
if (!onlyStatic) {
  console.log('\n========== 2/2 渲染校验（无头 Chromium 实测计算样式） ==========\n');
  const chromium = findChromium();
  if (!chromium) {
    console.log('⚠ 未找到本机 Chromium（Edge / Chrome），跳过渲染校验。');
    console.log('  安装任一款浏览器后重跑本命令即可；静态自检已经覆盖结构与逻辑。');
  } else {
    console.log('使用浏览器：' + chromium + '\n');

    // 三个校验台：任务 1 的外壳+首页、游戏下载页+拖拽安装、下载中心/运行环境两个面板
    const harnesses = [
      { file: 'tools/verify-shell.html', title: '任务 1 · 全局框架 + 首页' },
      { file: 'tools/verify-gamedl.html', title: '游戏下载页 + 全局拖拽安装' },
      { file: 'tools/verify-render.html', title: '下载中心 + 运行环境面板' },
    ];
    for (const harness of harnesses) {
      console.log(`---------- 渲染校验：${harness.title} ----------`);
      const dump = spawnSync(chromium, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--allow-file-access-from-files',           // 允许 file:// 下加载 ES 模块
        `--user-data-dir=${process.env.TEMP || '/tmp'}/wmc-verify-profile`,
        '--virtual-time-budget=22000',
        '--window-size=1520,1000',
        '--dump-dom', toFileUrl(harness.file),
      ], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });

      const parse = spawnSync(process.execPath, [join(ROOT, 'tools/parse-render-report.mjs')], {
        cwd: ROOT, input: dump.stdout ?? '', stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (parse.status !== 0) failed += 1;
      console.log('');
    }

    // 顺手把三个页面的截图留档，方便人工复核视觉
    mkdirSync(join(ROOT, '.verify'), { recursive: true });
    const shots = [
      ['home-dashboard.png', 'app.html', ''],
      ['home-dashboard-scrolled.png', 'app.html', '#'],   // 同页，第二张用于对比滚动区
      ['game-download.png', 'app.html?page=game', ''],
      ['mod-placeholder.png', 'app.html?page=mod', ''],
      ['download-center.png', 'index.html', ''],
      ['dropdown-open.png', 'index.html', '?open=source'],
      ['runtime.png', 'index.html', '?panel=runtime'],
    ];
    for (const [name, page, query] of shots) {
      spawnSync(chromium, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
        '--hide-scrollbars', '--virtual-time-budget=10000', '--window-size=1520,960',
        `--user-data-dir=${process.env.TEMP || '/tmp'}/wmc-shot-profile`,
        `--screenshot=${join(ROOT, '.verify', name)}`, toFileUrl(page) + query,
      ], { cwd: ROOT, stdio: 'ignore' });
    }
    const shots2 = readdirSync(join(ROOT, '.verify')).filter((f) => f.endsWith('.png'));
    console.log(`\n截图已写入 .verify/：${shots2.join(', ')}`);
  }
}

console.log('\n============================================');
console.log(failed === 0 ? '全部验证通过 ✅' : `存在 ${failed} 个失败的验证套件 ❌`);
process.exit(failed === 0 ? 0 : 1);