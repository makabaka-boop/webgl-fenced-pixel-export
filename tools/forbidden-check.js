const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const forbiddenPatterns = [
  { pattern: /\.toBlob\s*\(/, reason: '禁止直接对预览画布调用 toBlob；PNG 只能由读回字节的离屏 Canvas 编码。' },
  { pattern: /gl\.readPixels\([^\n]*null\)/, reason: '禁止同步 CPU readPixels；readPixels 必须写入 PIXEL_PACK_BUFFER。' },
  { pattern: /drawImage\s*\(/, reason: '本样张不实现图层或 CPU 重绘。' },
];

const failures = forbiddenPatterns
  .filter(({ pattern }) => pattern.test(appSource))
  .map(({ reason }) => reason);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Forbidden API check passed.');
