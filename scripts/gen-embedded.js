// 生成 src/embedded_assets.js —— 打包单文件 exe 时内嵌的 Web 静态资源(纯 UTF-8 文本)
// 用法: node scripts/gen-embedded.js [publicDir]
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const outFile = path.join(__dirname, '..', 'src', 'embedded_assets.js');

const map = {};
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    const rel = path.relative(publicDir, full).replace(/\\/g, '/');
    map[rel] = fs.readFileSync(full, 'utf8');
  }
})(publicDir);

fs.writeFileSync(outFile,
  '// 自动生成: node scripts/gen-embedded.js(勿手改;public 变更后重新生成)\n' +
  'module.exports = ' + JSON.stringify(map, null, 1) + ';\n');

console.log('✅ embedded_assets.js 已生成: ' + Object.keys(map).length + ' 个文件');
