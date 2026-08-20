module.exports = {
  apps: [{
    name: "AmzAllBlue",
    script: "./server.mjs",     // 相对当前目录
    interpreter: "node",
    watch: true,
    // 数据缓存和请求调试记录由运行中的任务持续写入；不能把它们当成代码变更。
    // 保留 watch 后，PM2 仍会在源码更新时重载，并会在进程异常退出时自动拉起。
    ignore_watch: ["node_modules", "logs", "data"]
  }]
};
