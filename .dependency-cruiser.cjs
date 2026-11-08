/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-no-core",
      comment: "src/shared 是两端共用的纯 TS 契约层。Node 核心模块属于宿主侧。",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "shared-no-platform-packages",
      comment:
        "src/shared 只依赖纯 TS 的 npm 包。react / electron 属于界面与壳。" +
        "按路径段匹配：包已安装时 to.path 是解析后的真实路径（node_modules/react/...）。",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "(^|/)(react|react-dom|electron)(/|$)" },
    },
    {
      name: "shared-no-host-or-client",
      comment: "src/shared 位于依赖图底部，由 host 与 client 共同引用。",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(host|client)/" },
    },
    {
      name: "client-object-no-react",
      comment: "src/client/object 是不带 React 的状态层，由 render 层接入视图。",
      severity: "error",
      from: { path: "^src/client/object/" },
      to: { path: "(^|/)(react|react-dom)(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // 不能把 node_modules 写进 exclude：那会把解析后的 npm 依赖整个从图里删掉，
    // 于是「src/shared 引 react」这类违规就永远报不出来。只排除编译产物。
    exclude: { path: "(^|/)(lib|lib-electron|lib-scripts|dist|release)/" },
    tsPreCompilationDeps: true,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
