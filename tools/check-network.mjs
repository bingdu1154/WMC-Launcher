#!/usr/bin/env node
/**
 * WMC · 版本服务联网验证（需要网络，独立于离线自检）
 * ---------------------------------------------------------------------------
 *   node tools/check-network.mjs
 *
 * 直接调用主进程的 wmc-version-service.js，分别走官方源与 BMCLAPI，
 * 用真实清单核对：数量、分类、愚人节识别、搜索、最新版、排序。
 * 自检脚本（check-ui.mjs）里只跑离线 fixture；这个脚本负责真机联网那一段。
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const service = require(join(ROOT, 'main', 'wmc-version-service.js'));

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

console.log('目标：' + join(ROOT, 'main', 'wmc-version-service.js'));
console.log('');

for (const source of ['official', 'bmclapi']) {
  try {
    const started = Date.now();
    const data = await service.listVersions({ source, category: 'release', limit: 5 });
    const ms = Date.now() - started;
    check(`[${source}] 拉取成功（${ms}ms，来源 ${data.sourceLabel}）`, data.items.length === 5,
      `总数 ${data.total} · 返回 ${data.items.length} 条 · 缓存 ${data.fromCache} · 降级 ${data.fallback}`);
    check(`[${source}] 最新正式版与清单 latest 一致`,
      data.latest.release?.id === data.items[0]?.id, `latest=${data.latest.release?.id} 首条=${data.items[0]?.id}`);
    check(`[${source}] 正式版列表按发布时间倒序`,
      data.items.every((v, i) => i === 0 || String(data.items[i - 1].releaseTime) >= String(v.releaseTime)),
      data.items.map((v) => `${v.id}@${String(v.releaseTime).slice(0, 10)}`).join(' > '));
    check(`[${source}] 分类计数齐全（release/snapshot/old/fools）`,
      data.counts.release > 50 && data.counts.snapshot > 100 && data.counts.old > 10,
      JSON.stringify(data.counts));
  } catch (error) {
    check(`[${source}] 拉取成功`, false, String(error?.message || error));
  }
}

try {
  const snapshot = await service.listVersions({ source: 'official', category: 'snapshot', limit: 3 });
  check('预览版分类可用', snapshot.items.length === 3 && snapshot.items.every((v) => v.category === 'snapshot'),
    snapshot.items.map((v) => v.id).join(', '));

  const old = await service.listVersions({ source: 'official', category: 'old', limit: 3 });
  check('远古版分类可用（含 old_beta / old_alpha）',
    old.items.length === 3 && old.items.every((v) => v.category === 'old'),
    old.items.map((v) => `${v.id}(${v.type})`).join(', '));

  const fools = await service.listVersions({ source: 'official', category: 'fools', limit: 20 });
  const foolsIds = fools.items.map((v) => v.id);
  check('愚人节版识别（真实清单里 8 个都认到）',
    ['15w14a', '1.RV-Pre1', '3D Shareware v1.34', '20w14infinite', '22w13oneblockatatime',
      '23w13a_or_b', '24w14potato', '25w14craftmine'].every((id) => foolsIds.includes(id)),
    `${fools.items.length} 个：${foolsIds.join(', ')}`);

  const search = await service.listVersions({ source: 'official', category: 'release', query: '26.3' });
  check('关键词搜索（26.3）', search.items.length > 0 && search.items.every((v) => v.id.includes('26.3')),
    search.items.map((v) => v.id).join(', ').slice(0, 60));

  const latest = await service.latestVersion({ source: 'bmclapi' });
  check('顶部大卡片用的最新正式版接口',
    latest.version && latest.version.type === 'release',
    `${latest.version?.id} · ${String(latest.version?.releaseTime).slice(0, 10)} · ${latest.sourceLabel}`);

  const detail = await service.versionDetail(latest.version.id, { source: 'official' });
  check('版本详情（安装要用：mainClass / 资源索引 / Java 要求）',
    !!detail.mainClass && !!detail.client?.url,
    `${detail.id} · mainClass=${detail.mainClass} · assets=${detail.assets} · Java ${detail.javaVersion?.majorVersion || '?'} · 库 ${detail.libraries} 个`);

  const cached = await service.listVersions({ source: 'official', category: 'snapshot', limit: 1 });
  check('第二次请求命中缓存', cached.fromCache === true, `fromCache=${cached.fromCache}`);
} catch (error) {
  check('真实接口链路', false, String(error?.message || error));
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? '✅' : '❌'} ${c.name}\n     ${c.detail}`);
console.log('');
console.log(`联网验证：共 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);