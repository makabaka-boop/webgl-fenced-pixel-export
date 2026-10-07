# WebGL2 像素样张

一个无构建步骤的静态 WebGL2 页面：用户编辑不超过 64×64 的 RGBA 整数网格，导出 PNG 时冻结点击时刻的修订、尺寸、像素和文件名。

## 范围

- 只做逐像素显示，不做色彩管理、复杂图层或 CPU 重绘。
- 预览使用 WebGL2 nearest filtering 的整数像素纹理。
- 每次导出创建独立快照，不引用后续会被编辑修改的网格。
- 读回通过 `PIXEL_PACK_BUFFER`、偏移 0 的异步 `readPixels` 和 `fenceSync` 排队。
- 显式轮询 fence；完成后才用 `getBufferSubData` 拷贝字节。
- 最多两份读回在途；每份任务持有自己的 PBO、纹理、FBO 与 sync，完成或取消前不复用。
- 读回后在 CPU 侧校正 WebGL 自下而上的行方向，再用离屏 `OffscreenCanvas` 编码 PNG。
- 不使用同步 CPU `readPixels`，也不直接对预览画布执行 `toBlob`。
- `webglcontextlost` 会让所有排队/在途任务明确失败并清理回调；恢复时只从保留的 CPU 编辑数据新建 GPU 对象，旧 fence 不参与新上下文。

## 本地运行

```bash
npm install
npm start
```

打开 <http://127.0.0.1:8080>。

## Docker Compose 发布静态页面

```bash
docker compose up -d
```

Nginx 直接发布 `public/`，端口映射为 `8080:80`。

## 浏览器测试

测试使用 Chromium 的软件 WebGL2（SwiftShader/ANGLE），不要求独立显卡。

```bash
npm install
npm run test:install-browser
npm test
```

如果容器或精简桌面系统缺少 Chromium 系统库，在可使用 sudo/root 的环境中执行：

```bash
npx playwright install-deps chromium
npm test
```

测试覆盖：

1. 交错两份不同尺寸导出、尺寸/颜色编辑和第三份排队任务；受控轮询 fence 后，用 `pngjs` 逐字节核对下载 PNG 与各自点击时快照，并核对文件名。
2. 在有两份在途和一份排队任务时调用 `WEBGL_lose_context`，确认所有任务失败、没有空 PNG；恢复上下文后从 CPU 数据重建 GPU 资源，再次导出并核对像素，确认旧 fence 不参与新上下文。

`?manualPoll=1` 会停止自动轮询，仅通过 `window.__pixelTestHooks.pollOnce()` 推进 fence，供测试确定性交错。

## 文件

- `public/index.html`、`public/styles.css`、`public/app.js`：静态页面与 WebGL2 实现。
- `tests/exports.spec.js`：受控轮询、快照一致性和上下文丢失/恢复测试。
- `tools/static-server.js`：测试用零依赖静态服务器。
- `tools/forbidden-check.js`：检查禁止的预览 `toBlob`、同步读回和 CPU 重绘 API。
- `docker-compose.yml`、`nginx.conf`：静态发布配置。
