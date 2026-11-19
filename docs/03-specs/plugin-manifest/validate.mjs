// 用法：
//   npm install                     # js-yaml + ajv
//   node validate.mjs [manifest.yaml]
// 说明：JSON Schema 只能校验结构；悬空 capabilityRef、egress 越权、destructive 未审批
//       等跨字段约束由本脚本补齐（见报告 7.4 节）。路径逃逸等运行期检查仍由加载器负责。

import fs from 'node:fs';
import * as yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('./manifest.schema.json', import.meta.url);
const target = process.argv[2] ?? 'example.plugin.yaml';

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const doc = yaml.load(fs.readFileSync(target, 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(schema);
const ok = validate(doc);

console.log(`schema: ${ok ? 'PASS' : 'FAIL'}  (${target})`);
if (!ok) {
  for (const e of validate.errors ?? []) {
    console.log(`  - ${e.instancePath || '<root>'} : ${e.message} ${JSON.stringify(e.params)}`);
  }
}

// ── 语义层检查 ─────────────────────────────────────────────
const warnings = [];
const PREFIX = { skills: 'skill', mcpServers: 'tool', openapi: 'tool', agents: 'agent', workflows: 'workflow', apps: 'app' };
const known = new Set();
for (const [group, prefix] of Object.entries(PREFIX)) {
  for (const c of doc.components?.[group] ?? []) known.add(`${prefix}:${c.id}`);
}

for (const intent of doc.routing?.intents ?? []) {
  for (const ref of intent.capabilityRefs ?? []) {
    const head = ref.split('.')[0];            // tool:deploy-api.createDeployment -> tool:deploy-api
    if (!known.has(head)) warnings.push(`intent ${intent.id}: 无法解析的 capabilityRef "${ref}"`);
  }
}

const declared = new Set(
  (doc.permissions ?? []).filter((p) => p.id === 'net.egress').flatMap((p) => p.hosts ?? []),
);
for (const host of doc.runtime?.sandbox?.network?.egress ?? []) {
  if (!declared.has(host)) warnings.push(`sandbox egress "${host}" 未在 permissions.net.egress 中声明`);
}

for (const intent of doc.routing?.intents ?? []) {
  if (intent.destructive && !intent.requiresApproval) {
    warnings.push(`intent ${intent.id}: destructive 但未要求审批`);
  }
}

for (const w of warnings) console.log(`  ! ${w}`);
console.log(warnings.length === 0 ? 'semantics: PASS' : `semantics: ${warnings.length} warning(s)`);
process.exit(ok && warnings.length === 0 ? 0 : 1);
