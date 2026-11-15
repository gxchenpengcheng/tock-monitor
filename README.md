# 云端股票信号监控（GitHub Actions + Server酱 → 微信）

监控跑在 GitHub 的服务器上（每15分钟，交易时段），**不依赖你的电脑**——关机、换电脑、睡眠都不影响。

## 信号逻辑

与本地版 `stock-backtest/monitor` 完全一致：拉取标的日线+30分钟K线（腾讯财经），用 `index.html` 里的策略引擎在**已收盘**的K线上判断 MA5/20 翻转点，新信号通过 Server酱 推送到微信。状态文件 `monitor/state.json` 每次运行后提交回仓库实现跨运行去重。

## 首次部署步骤（约10分钟）

### 1. 领取 Server酱 SendKey

1. 打开 <https://sct.ftqq.com>，用微信扫码登录。
2. 点「SendKey」页，复制形如 `SCTxxxxx...` 的密钥。
3. 微信里关注「方糖」服务号（页面会提示），消息就是从这里来的。

### 2. 创建 GitHub 仓库并上传文件

1. 登录 <https://github.com>，右上角 + → New repository。
2. 仓库名随意（如 `stock-monitor`），选 **Public**，勾选 Add a README，创建。
3. 把本目录 `cloud-monitor` 下的内容上传到仓库根目录：
   - 网页上传：仓库页 Add file → Upload files，把 `index.html`、`monitor/` 文件夹、`.github/` 文件夹拖进去（注意 `.github` 是隐藏文件夹，资源管理器里直接拖整个文件夹即可）。
   - 或用 git 命令行推送。
   仓库结构应是这样：
   ```
   ├── index.html                      （策略引擎）
   ├── monitor/
   │   ├── cloud-monitor.mjs           （监控脚本）
   │   └── config.json                 （标的/策略配置）
   └── .github/workflows/monitor.yml   （定时任务）
   ```

### 3. 配置密钥

仓库页 → Settings → Secrets and variables → Actions → New repository secret：
- Name：`SCT_SENDKEY`
- Secret：粘贴你的 Server酱密钥

### 4. 手动触发一次测试

仓库页 → Actions → 左侧 stock-signal-monitor → 右侧 **Run workflow** → 勾选
「只发一条测试消息验证通道」→ Run workflow。

- 勾选测试：会立刻给微信「方糖」服务号推一条 `【测试】信号监控推送通道正常`，**不改动信号状态**。这是验证通道最直接的办法。
- 不勾选（默认）：正常巡检。日志出现 `[done] {"ok":true,...}` 即成功；**第一次运行只记基线不报警**（日志里 `"baseline":true,"pushed":false`），属正常。

> 注意：新仓库如果以前没用过 Actions，先去 Actions 页点绿色按钮启用。

## 改监控标的 / 策略

改 `monitor/config.json`（字段含义见 `stock-backtest/monitor/README.md`），提交后在 Actions 里手动跑一次，让它重建基线。换策略记得核对 `state.json`（删掉该文件让脚本重记基线也行）。

## 日常注意

- GitHub 定时任务有 **几分钟级别的触发延迟**，属正常，不影响收盘K线的判断。
- 公开仓库若 **60 天没有任何提交**，GitHub 会自动停用定时任务；本任务每次有信号都会提交状态，长期无信号时可在 Actions 页手动跑一次保活。
- 仓库设为 Public 没问题：密钥存在 Secrets 里不会出现在代码或日志中。

## 本地测试

```
set DRY_RUN=1
set SCT_SENDKEY=假密钥
node monitor/cloud-monitor.mjs
```
DRY_RUN 模式只打印推送内容不真发。加 `set TEST_PUSH=1` 可强制发一条测试推送（不含信号状态）。

> 踩坑：Windows 下用 curl / 批处理发中文时，默认按 GBK 编码，Server酱 会返回
> `30001 database error ... Incorrect string value`。这是**本机 shell 编码问题**，不是密钥问题——
> GitHub Actions 是纯 UTF-8，不会出现。本地要用 Node/Python 显式 UTF-8 编码发送。
