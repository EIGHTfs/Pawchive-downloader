#!/usr/bin/env node
/**
 * test/env-compat.test.js —— KToolBox-env-compat 双向翻译中枢测试（零依赖）
 *
 * 覆盖：readPawchiveEnv（PAWCHIVE_* → 配置对象）/ toKToolBox（反向写真实值）/ writeEnv（.env 写）
 * 用法：node test/env-compat.test.js
 */
'use strict';

const { readPawchiveEnv, toKToolBox, writeEnv } = require('../scripts/KToolBox-env-compat.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log('[env-compat] KToolBox-env-compat 双向翻译中枢测试\n');

// 1. readPawchiveEnv：PAWCHIVE_* → 配置对象
const env = {
  PAWCHIVE_API_BASE: 'https://pawchive.pw/api/v1',
  PAWCHIVE_FILES_BASE: 'https://file.pawchive.pw',
  PAWCHIVE_CONCURRENCY: '5',
  PAWCHIVE_INCLUDE_REVISIONS: '1', // 默认开
  PAWCHIVE_CREATOR_DIR_FORMAT: '{creator_name} [{service}-{creator_id}]',
  PAWCHIVE_POST_DIR_FORMAT: '{title} [{post_id}]',
  PAWCHIVE_FILENAME_FORMAT: '{}',
  PAWCHIVE_ATTACHMENTS_SUBDIR: '',
  PAWCHIVE_INDEX_FILENAME: 'pawchive-index.html',
  PAWCHIVE_REVISIONS_SUBDIR: 'revisions',
  PAWCHIVE_USER_AGENT: 'test-ua',
};
const cfg = readPawchiveEnv(env);
check('readPawchiveEnv.apiBase', cfg.apiBase === 'https://pawchive.pw/api/v1');
check('readPawchiveEnv.includeRevisions 默认开', cfg.includeRevisions === true);
check('readPawchiveEnv.indexFilename', cfg.indexFilename === 'pawchive-index.html');
check('readPawchiveEnv.userAgent', cfg.userAgent === 'test-ua');
check('readPawchiveEnv.revisionsSubdir 默认', cfg.revisionsSubdir === 'revisions');

// 2. toKToolBox：反向写真实值（KToolBox 兼容我们）
const kt = toKToolBox(env);
check('toKToolBox API scheme/netloc/path', kt.KTOOLBOX_API__SCHEME === 'https' && kt.KTOOLBOX_API__NETLOC === 'pawchive.pw' && kt.KTOOLBOX_API__PATH === '/api/v1');
check('toKToolBox 并发', kt.KTOOLBOX_JOB__COUNT === '5');
check('toKToolBox include_revisions 写真实值（默认开→true）', kt.KTOOLBOX_JOB__INCLUDE_REVISIONS === 'true');
check('toKToolBox post_structure.content 映射 INDEX_FILENAME', kt.KTOOLBOX_JOB__POST_STRUCTURE__CONTENT === 'pawchive-index.html');
check('toKToolBox post_structure.revisions', kt.KTOOLBOX_JOB__POST_STRUCTURE__REVISIONS === 'revisions');
check('toKToolBox attachments 空→"."', kt.KTOOLBOX_JOB__POST_STRUCTURE__ATTACHMENTS === '.');
check('toKToolBox external_links FALSE 语义（原版默认+生成关）', kt.KTOOLBOX_JOB__POST_STRUCTURE__EXTERNAL_LINKS === 'external_links.txt' && kt.KTOOLBOX_JOB__EXTRACT_EXTERNAL_LINKS === 'false');
check('toKToolBox max_active_tasks 对齐并发', kt.KTOOLBOX_WEBUI__MAX_ACTIVE_TASKS === '5');

// 3. toKToolBox 关闭修订（PAWCHIVE_INCLUDE_REVISIONS=0 → false）
const ktOff = toKToolBox({ ...env, PAWCHIVE_INCLUDE_REVISIONS: '0' });
check('toKToolBox include_revisions 关闭→false', ktOff.KTOOLBOX_JOB__INCLUDE_REVISIONS === 'false');

// 4. writeEnv：.env 写（临时文件——替换/追加）
const tmpEnv = path.join(os.tmpdir(), `envtest-${Date.now()}.env`);
fs.writeFileSync(tmpEnv, 'PAWCHIVE_A=1\nPAWCHIVE_B=2\n', 'utf8');
writeEnv('PAWCHIVE_A', '9', tmpEnv); // 替换
writeEnv('PAWCHIVE_C', '3', tmpEnv); // 追加
const after = fs.readFileSync(tmpEnv, 'utf8');
check('writeEnv 替换', /^PAWCHIVE_A=9$/m.test(after));
check('writeEnv 追加', /^PAWCHIVE_C=3$/m.test(after));
check('writeEnv 保留其他', /^PAWCHIVE_B=2$/m.test(after));
fs.rmSync(tmpEnv, { force: true });

console.log(`\n[env-compat] 结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
