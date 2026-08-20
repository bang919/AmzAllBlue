module.exports = {
  apps: [{
    name: "AmzAllBlue",
    script: "./server.mjs",     // 相对当前目录
    interpreter: "node",
    // 只监控源码位置，避免运行数据、Git 元数据或日志导致重启循环。
    // PM2 仍会在进程异常退出时自动拉起服务。
    watch: ["server.mjs", "lib", "public", "scripts"]
  }]
};
