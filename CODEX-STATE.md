# DeepSeek 本地三维工作室

## 目标与约束
- 编写完整、可安装的 DeepSeek Harness 插件，接收文字、图片、视频。
- 流程：硬件识别 → 需求与场景方案 → 可调整样例 → 人工确认 → 模型、动画、渲染、打包。
- 沿用现有 DeepSeek；不增加云端 API Key、订阅或按次生成费用。
- 自动识别显卡型号、独立显存、内存及工具；未知数值不填零，不假称硬件足够。
- 单代理；使用 cmd.exe / Node / Python；不使用 PowerShell。
- 用户已授权一次离线检查，并追加兼容与全流程源码检查和缺失功能修复；本轮检查已使用。修复后不自动复验，也不安装权重、不实际渲染。

## 关键决定
- 独立目录：E:/DeepSeek/deepseek-3d-studio，不修改已有项目。
- 使用官方 dsh.bundle / Cordis 工具扩展格式，沿用 Harness 的模型和交互服务。
- 最新用户决定：尽量复用现成插件和 skill，不自写建模引擎。默认通过 Blenderwright 完成建模、动画、渲染；本插件编写必要的编排、硬件识别、审批与安装胶水。
- 可选本地 TripoSR / Hunyuan3D 适配器；不存在的依赖明确报告，不悄悄改用收费云端。
- 视频区分静态多视图重建和动态场景近似复刻；不宣称任意视频可精确恢复模型和动作。
- 审批绑定具体样例修订版；修改方案会使旧审批失效；取消保留项目。

## 进度
- 已读取编程、计划及产品交互技能，研究 Harness 官方插件与工具接口。
- 已编写 DSH bundle 入口、硬件识别、配置、隔离进程、持久化状态、样例审批和后台编排。
- 已接入官方 MCP 客户端与 Blenderwright，使用上游结构化工具；没有自写建模引擎。
- 已编写本地项目发现、官方仓库获取、隔离安装、公开权重获取及适配声明。
- 已编写 TripoSR CLI、混元薄适配、ComfyUI、COLMAP/FFmpeg/librosa 编排入口。
- 已编写一句话 quick 入口、逐轮需求访谈、用户已知事实记录与主动更正、需求摘要确认。
- 已编写 README、配置、本地项目接入文档、现成工具调用示例和离线测试用例。
- 用户新要求：优先使用用户本地更适配项目；缺少能力时克隆官方项目到专用目录，隔离安装。自定义项目通过适配声明接入。
- 用户最高优先级要求：一句话先生成基础模型样例，再问特别需求和精细化；有特别需求时进入 grill-me 式逐轮需求访谈。
- 用户补充：硬件识别与定制方案必须内置插件。
- 已执行 scripts/offline_check.py 一次：当时 JS/Python 语法、包结构通过；16 个单元用例 8 通过，8 个都在公共夹具首次临时 JSON rename 发生 EPERM，未进入业务断言。
- 原始报告 dist/offline-check-c3cccb3c.json，对应修复前版本。修复和新增用例尚未复验。
- 已追加 compatibility.mjs / workflow.mjs：DSH 本地组件版本与服务识别、模型身份和视觉三态、前台/图片链接降级、缺原生问答时明确阻断、阶段缺项与准备动作。
- 已补充用户 outputs 与详细需求意图；预览必须真实 .blend，最终交付必须工程和模型；动画请求必须视频和多帧，正式效果图请求必须 renders。
- 已应用专用 Blender 场景的分辨率、帧率、帧范围；可刷新指定项目硬件；新增 media 隔离配方 librosa==0.11.0 / mediaPython。
- 已收紧等待用户回答期间的需求/批准变化判断；测试临时目录改为项目 .test-tmp，生产写入保留原子性并增加权限错误提示。
- 追加检查与修复详情 docs/COMPATIBILITY-AND-WORKFLOW.md。

## 下一步
1. 若要上架插件市场：先 `npm login`，再 `npm publish --access public`，然后向 awesome-dsh-plugin 提 PR（材料见 dist/MARKET-SUBMISSION.md 与 dist/market-entry.json）。
2. 真实建模/渲染链路仍缺 Blender 与模型权重，未验证，需要用户确认后再安装与跑样例。
3. 依赖安装首次使用需调用 `studio_three action=setup`（已在本机活动 dataRoot 装好 three 与 @gltf-transform/*）。

## 2026-10-22 更新（安装、Three.js 通道、缺陷修复）
- 以 `plugin_manager install_bundle` 安装为 `dsh-local-3d-studio`（profile package.json 里是 `link:E:/DeepSeek/deepseek-3d-studio`），20 个 `studio_*` 工具注册成功。
- 新增 Three.js 模型通道：`studio_three`（setup/demo/inspect/edit/viewer）+ `workers/model_edit.mjs` + `src/three.mjs`；模型改写走 @gltf-transform，预览页内嵌 base64 + three CDN。
- 版本 0.2.1 修复：viewer/edit 省略 outputPath 时把 Promise 当路径的缺陷；Windows + Node 24 下 npm.cmd spawn EINVAL（改为解析 npm-cli.js 用 node 直接跑，找不到才经 cmd.exe）；依赖安装与运行统一用活动 dataRoot。
- 验证：`node --test tests/core.test.mjs` 21 pass / 0 fail；demo 生成 GLB、inspect、edit、viewer 全链路实测；全新代理报告 setup 与默认路径问题后修复并复验。
- 插件开关实测：disable 后系统提示注入与全部 `studio_*` 工具同时消失，enable 后恢复——开关作用于工具与提示两处。
- dist 已打包 `dsh-local-3d-studio-0.2.1.tgz` / `.zip`；npm 未登录（ENEEDAUTH），未实际 publish。


## 环境与验证
- 工作目录 E:/DeepSeek；Node 和 Python 已有可执行路径。
- 没有创建分支或提交；插件目录为新建文件。
- 官方源码公开读取在默认网络受限时失败，已通过自动审批的 curl 只读请求继续。
- 本轮追加官方源码读取失败（网络/404/403），未取得新接口证据；沿用本地保存的 DSH 0.2.1-rc.2 / Blenderwright 2.3.0 参考，不假称验证更新版本。
- 本轮 where dsh 在当前 PATH 未找到命令，不代表全机未安装；没有启动宿主或读取凭据。

## 重要路径
- index.mjs：DSH 工具入口及原生人机交互。
- src/engine.mjs / src/blender.mjs：现成插件编排与专用 Blender 生命周期。
- src/dependencies.mjs / src/adapters.mjs：本地优先、缺失获取和本地模型适配。
- src/interview.mjs / recipes/orchestrator.md：默认先建模、按需深入访谈。
- tests/core.test.mjs：审批、归属、路径、访谈、硬件、兼容和降级用例；原版已运行一次，修复/新增版未运行。
- src/compatibility.mjs / src/workflow.mjs：新兼容与阶段能力报告，未实测。
- .reference/：官方源码参考，不进入安装包；不是用户项目成果的检查结果。

## 真实能力边界
- 用户仍需 Blender / Python / Git 等基础工具；不做系统级安装和驱动配置。
- ComfyUI 使用已有可运行本机服务、节点和 API 工作流，不假称克隆源码即具备任意生成能力。
- 用户自定义入口须声明 localOnly；不审计任意第三方实现。
- 视频静态重建与动态近似复刻明确区分。
- 所有集成仍未实测；交付说明必须保留这一点。
- 模型路由未公开时不能保证自动识别确切模型；可用 modelRoute / visionMode 补充。未知 DSH 主版本不强行兼容，也不自动升级宿主。
- 不具备对任意社区 ComfyUI 节点和权重的自动装配；可复用现成 API 工作流/适配声明，缺少时走真三维 Blender 预览。

## 2026-10-22 全链路与自动探测（0.3.1）
- 新增 studio_probe（每次实测 Blender/COLMAP/FFmpeg/FFprobe/Python/ComfyUI）与 studio_three generate/render；系统提示规定先 probe 再选路线。
- 本机实测：Blender/COLMAP 缺失、ComfyUI 8188 不可达、FFmpeg 9.0.2、Python 3.14.7；pipeline.modeling 自动落到 three-procedural。
- 工具层验证：generate 办公桌 35,400B；render front 28,060 / right 27,735 / iso 47,090；viewer 离线单文件。
- 修复 0.3.1：cylinder 不认 radius、追景距离过远；dist 产出 0.3.1 tgz/zip 与 market-entry 0.3.1。
- 待办：npm 未登录（ENEEDAUTH），市场发布仍只到「可安装包 + 登记材料」。

## 2026-10-22 上架准备（GitHub 仓库 + 市集 PR）
- 公开仓库：https://github.com/RoderickWilliams/dsh-local-3d-studio（55 文件，MIT，topic `dsh-plugin`，`screenshots.json` 两张渲染图）。
- `package.json` 补齐 `repository` / `homepage` / `bugs` / `publishConfig`，并修正描述里的乱码（原为 GBK 往返损坏）。
- 市集 PR #8638：新增 `data/plugins/RoderickWilliams__dsh-local-3d-studio.yml`（category `tools`）。规则要求仓库创建满 1 天，仓库建于 2026-10-22T07:25Z，次日同一分支推空提交重跑 CI。
- npm 发布仍待用户 `npm login --auth-type=legacy`；本机 npm 官方源连通，未登录。
