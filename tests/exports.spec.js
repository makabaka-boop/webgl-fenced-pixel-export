const { test, expect } = require('@playwright/test');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

async function decodeDownload(download) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-export-'));
  const filePath = path.join(directory, download.suggestedFilename());
  await download.saveAs(filePath);
  const buffer = await fs.readFile(filePath);
  const png = PNG.sync.read(buffer);
  return {
    filePath,
    fileName: download.suggestedFilename(),
    buffer,
    width: png.width,
    height: png.height,
    pixels: Array.from(png.data),
  };
}

async function invoke(page, method, ...args) {
  return page.evaluate(
    async ({ method, args }) => window.__pixelTestHooks[method](...args),
    { method, args },
  );
}

async function waitForActiveReadback(page, expected = 2) {
  await expect.poll(
    async () => {
      const state = await invoke(page, 'getState');
      return state.active.length;
    },
    { timeout: 5000, intervals: [10, 20, 50] },
  ).toBe(expected);
  return invoke(page, 'getState');
}

function attachDownloadBuffer(page) {
  const buffer = { byName: new Map(), resolvers: new Map() };
  page.on('download', (download) => {
    const name = download.suggestedFilename();
    const resolver = buffer.resolvers.get(name);
    if (resolver) {
      buffer.resolvers.delete(name);
      resolver(download);
    } else {
      buffer.byName.set(name, download);
    }
  });
  buffer.forName = (name) => {
    const buffered = buffer.byName.get(name);
    if (buffered) {
      buffer.byName.delete(name);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve) => buffer.resolvers.set(name, resolve));
  };
  return buffer;
}

async function takeDownloadNamed(buffer, fileName) {
  return buffer.forName(fileName);
}

async function waitForTasksDone(page, ids) {
  const idSet = new Set(ids);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await invoke(page, 'pollOnce');
    const tasks = await invoke(page, 'getTasks');
    const selected = tasks.filter((task) => idSet.has(task.id));
    if (selected.length === ids.length && selected.every((task) => task.status === 'done')) {
      return selected;
    }
    if (selected.some((task) => task.status === 'failed')) {
      throw new Error(`导出意外失败：${JSON.stringify(selected)}`);
    }
  }
  throw new Error('fence 没有在受控轮询中完成');
}

function expectPixels(png, snapshot) {
  expect(png.width).toBe(snapshot.width);
  expect(png.height).toBe(snapshot.height);
  expect(png.pixels.length).toBe(snapshot.pixels.length);
  expect(png.pixels).toEqual(snapshot.pixels);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?manualPoll=1');
  await expect.poll(() => invoke(page, 'isContextLost')).toBe(false);
});

test('两份不同尺寸导出由受控 fence 轮询完成，并保持点击时快照和文件名', async ({ page }) => {
  const downloads = attachDownloadBuffer(page);

  // 第一份快照：9×6，填充一个稳定但非纯背景的颜色。
  await invoke(page, 'setSize', 9, 6);
  await invoke(page, 'fill', [250, 20, 30, 255]);
  await invoke(page, 'setPixel', 0, 0, [0, 255, 100, 255]);
  await invoke(page, 'setPixel', 8, 5, [4, 8, 16, 255]);
  const snapshotA = await invoke(page, 'getState');
  const taskA = await invoke(page, 'requestExport');

  // 不轮询，立即把当前 CPU 编辑改成 6×6。任务 A 已克隆，不能受到影响。
  await invoke(page, 'setSize', 6, 6);
  await invoke(page, 'fill', [10, 20, 230, 255]);
  const snapshotB = await invoke(page, 'getState');
  const taskB = await invoke(page, 'requestExport');

  await waitForActiveReadback(page, 2);
  let stateAfterBoth = await invoke(page, 'getState');
  expect(stateAfterBoth.active).toHaveLength(2);
  expect(stateAfterBoth.active[0].hasSync).toBe(true);
  expect(stateAfterBoth.active[0].hasPbo).toBe(true);
  expect(stateAfterBoth.active[0].live).toBe(true);
  expect(stateAfterBoth.active[1].id).not.toBe(stateAfterBoth.active[0].id);

  // 第三份任务排队，证明最多两份在途。
  await invoke(page, 'fill', [90, 90, 90, 255]);
  const taskC = await invoke(page, 'requestExport');
  stateAfterBoth = await invoke(page, 'getState');
  expect(stateAfterBoth.active).toHaveLength(2);
  expect(stateAfterBoth.pending).toEqual([taskC.id]);

  // 第一次显式轮询只允许查询 fence；在极小 SwiftShader 任务上它可能已完成。
  const firstPoll = await invoke(page, 'pollOnce');
  expect(firstPoll.advanced + firstPoll.waited).toBeGreaterThan(0);

  await waitForTasksDone(page, [taskA.id, taskB.id]);

  // 第三份任务在前两份释放 PBO/fence 槽位后才启动，使用编辑后的 6×6 快照。
  await waitForActiveReadback(page, 1);
  await waitForTasksDone(page, [taskC.id]);

  const [pngA, pngB, pngC] = await Promise.all([
    takeDownloadNamed(downloads, taskA.fileName).then(decodeDownload),
    takeDownloadNamed(downloads, taskB.fileName).then(decodeDownload),
    takeDownloadNamed(downloads, taskC.fileName).then(decodeDownload),
  ]);

  expect(pngA.fileName).toBe(taskA.fileName);
  expect(pngB.fileName).toBe(taskB.fileName);
  expect(pngC.fileName).toBe(taskC.fileName);
  expect(pngA.fileName).toMatch(/^pixel-sheet-r[0-9]+-9x6-[0-9]{4}\.png$/);
  expect(pngB.fileName).toMatch(/^pixel-sheet-r[0-9]+-6x6-[0-9]{4}\.png$/);
  expect(pngA.fileName).not.toBe(pngB.fileName);

  expectPixels(pngA, snapshotA);
  expectPixels(pngB, snapshotB);
  const snapshotC = await invoke(page, 'getState');
  expectPixels(pngC, snapshotC);

  const tasks = await invoke(page, 'getTasks');
  const byId = new Map(tasks.map((task) => [task.id, task]));
  expect(byId.get(taskA.id).status).toBe('done');
  expect(byId.get(taskB.id).status).toBe('done');
  expect(byId.get(taskC.id).status).toBe('done');
});

test('context lost 让未读回任务失败，恢复后重建 GPU 并保留交错编辑的导出快照', async ({ page }) => {
  const downloads = attachDownloadBuffer(page);

  await invoke(page, 'setSize', 7, 5);
  await invoke(page, 'fill', [255, 0, 0, 255]);
  const lostSnapshotA = await invoke(page, 'getState');
  const lostTaskA = await invoke(page, 'requestExport');

  await invoke(page, 'setSize', 5, 4);
  await invoke(page, 'fill', [12, 99, 220, 255]);
  await invoke(page, 'setPixel', 4, 0, [255, 255, 0, 255]);
  const lostSnapshotB = await invoke(page, 'getState');
  const lostTaskB = await invoke(page, 'requestExport');

  await waitForActiveReadback(page, 2);
  const beforeLost = await invoke(page, 'getState');
  expect(beforeLost.active.map((job) => job.hasSync)).toEqual([true, true]);

  // 第三份任务尚未取得 PBO，也必须在丢上下文时得到明确拒绝。
  await invoke(page, 'setPixel', 0, 3, [1, 2, 3, 255]);
  const lostTaskC = await invoke(page, 'requestExport');
  await expect(invoke(page, 'loseContext')).resolves.toBeUndefined();

  await expect.poll(() => invoke(page, 'isContextLost')).toBe(true);
  const lostState = await invoke(page, 'getState');
  expect(lostState.active).toEqual([]);
  expect(lostState.pending).toEqual([]);

  const tasksAfterLost = await invoke(page, 'getTasks');
  for (const id of [lostTaskA.id, lostTaskB.id, lostTaskC.id]) {
    const task = tasksAfterLost.find((item) => item.id === id);
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/上下文|读回/);
  }
  expect(lostState.width).toBe(lostSnapshotB.width);
  expect(lostState.height).toBe(lostSnapshotB.height);

  await expect(invoke(page, 'requestExport')).rejects.toThrow(/上下文/);

  // 上下文丢失期间继续保留 CPU 编辑；恢复后由这些数据创建全新 GPU 资源。
  await invoke(page, 'fill', [0, 255, 0, 255]);
  await invoke(page, 'setPixel', 1, 1, [12, 34, 56, 255]);
  await invoke(page, 'restoreContext');
  await expect.poll(() => invoke(page, 'isContextLost')).toBe(false);

  const restoredSnapshot = await invoke(page, 'getState');
  expect(restoredSnapshot.width).toBe(5);
  expect(restoredSnapshot.height).toBe(4);
  expect(restoredSnapshot.pixels).not.toEqual(lostSnapshotB.pixels);

  const restoredTask = await invoke(page, 'requestExport');
  await waitForActiveReadback(page, 1);
  const restoredState = await invoke(page, 'getState');
  expect(restoredState.active).toHaveLength(1);
  expect(restoredState.active[0].id).toBe(restoredTask.id);
  expect(restoredState.active[0].hasSync).toBe(true);

  await waitForTasksDone(page, [restoredTask.id]);
  const download = await takeDownloadNamed(downloads, restoredTask.fileName);
  const restoredPng = await decodeDownload(download);
  expect(restoredPng.fileName).toBe(restoredTask.fileName);
  expectPixels(restoredPng, restoredSnapshot);
});
