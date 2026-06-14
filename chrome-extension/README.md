# Amazon Aggregator Chrome Collector

## 安装

1. 先启动本地服务：`node server.mjs`
2. 打开 Chrome 扩展管理页：`chrome://extensions/`
3. 打开“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择本目录：`chrome-extension`

## 使用

打开这个页面即可自动采集：

`https://advertising.amazon.com/bi?entityId=ENTITYTLD43M1F4RXU`

插件不会显示页面 UI，也不会在其他 Amazon Advertising 页面工作。它会在页面登录态里静默调用：

- `/bi/api/chat/get`
- `/bi/api/chat/messages/list`

采集到的 API 响应会写入本地：

`http://localhost:4317/api/debug/network`

回到本地工具 `http://localhost:4317` 后刷新，就能看到线程和对话详情。
