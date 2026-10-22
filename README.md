# DeepSeek 本地三维工作室

一个适配 DeepSeek Harness 的安装包，把现成的建模、生成、动画、渲染项目与 skill 串成同一条工作流。沿用用户已有的 DeepSeek；不要求额外三维平台 API Key、订阅或充值。DeepSeek 本身原有的用量、本机算力和磁盘占用仍然存在。

## 核心交互

**只说一句话，也先做出模型。** 例如“帮我做一辆科幻摩托车”：插件默认进入 quick 模式，用现成 Blenderwright 工具做基础模型和样图，再询问是否有特别需求、是否继续精细化。没有要求动画时不会擅自制作长视频。

**有特别需求，再深入追问。** 访谈沿用 grill-me / grilling 的决策树方法：每轮 1—3 个关键问题，解决当前能决定的问题；保留已给答案，自动查硬件，不让用户重复填写。区分用途、视觉细节、参考还原、尺寸精度、材质、动作、镜头、音频和交付格式。需求摘要确认后再做调整样例。

**正式制作由用户决定。** 文字、图片、视频输入均先展示真实样例；确认只对当前修订版生效。方案、样图或预览工程变化后旧确认失效；完整制作失败后不会擅自重复消耗资源。

## 现成能力的复用

| 环节 | 复用项目 | 本插件只负责 |
| --- | --- | --- |
| 文字理解、需求访谈、场景拆解 | 当前 DeepSeek + 本地 skill | 提供流程、保留答案和决策 |
| 建模、材质、灯光、骨骼、动画、渲染、导出 | [Blenderwright](https://github.com/HoldMyBeer-gg/blenderwright) + Blender | 经 DSH 官方 MCP 客户端编排结构化工具 |
| 图生模型 | [TripoSR](https://github.com/VAST-AI-Research/TripoSR) / [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) | 调用官方 CLI 或薄适配入口 |
| 概念样图及用户已有生成工作流 | [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 接入用户已有 API 工作流与本机服务 |
| 静态环绕视频重建 | [COLMAP](https://github.com/colmap/colmap) | 串联其官方 CLI 命令 |
| 视频抽帧、成片、音乐候选拍点 | FFmpeg / FFprobe / librosa，及现有媒体 skill | 输入输出与时间线衔接 |
| 更适合用户的本地项目 | `local-3d.adapter.json` | 提供统一命令 / ComfyUI 接入声明 |

不实现新的几何引擎、渲染器、三维神经网络或视频生成模型。动态视频的近似复刻由当前 DeepSeek 读取参考帧后编排现有建模与动画工具，不承诺任意视频都能精确恢复完整三维和动作。只有完成模型文件和工程导出，才称为三维交付；二维生成视频不能替代三维资产。

## 本地优先与缺失获取

优先级：用户 `preferredProjects` 指定目录 → 用户的适配声明 → 已识别的本地项目 → 插件托管副本。目录扫描有界：默认最多 600 个目录、两层；更深的项目请直接添加到 `preferredProjects`。

没有必要项目时，`studio_setup` 会展示具体来源，然后克隆登记的官方仓库，并在 `dataRoot/_dependencies` 新建隔离 Python 环境。**不会在用户仓库里执行升级、重置、迁移或覆盖操作。** 权重下载单独说明许可和磁盘影响；运行模型时开启 Hugging Face 离线模式，不自动切换云端服务。

自定义项目不会因被扫描到就执行代码。它的入口和声明先供 DeepSeek 选择；用户明确选择该能力后才纳入制作方案。详见 [本地项目接入](docs/LOCAL-PROJECTS.md)。

## 安装到 DSH

基础环境：DSH 0.2.1 系列、Node 22+、Python 3.10+；Blenderwright 需要 Blender 4.2+ 桌面版。缺少项目自动克隆需要 Git。视频和音乐步骤需要 FFmpeg / FFprobe。插件不安装显卡驱动、管理员工具链或系统级 Python。

在你现有的 DSH profile 上安装，不必更换 DeepSeek 模型配置。将 `YOUR_PROFILE` 替换为正在使用的 profile 名：

```text
dsh plugin --profile YOUR_PROFILE add E:/DeepSeek/deepseek-3d-studio
```

也可以安装交付的 `.tgz`：

```text
dsh plugin --profile YOUR_PROFILE add E:/DeepSeek/deepseek-3d-studio/dist/dsh-local-3d-studio-0.1.0.tgz
```

随后用原来的命令重新打开该 profile。不要为安装本插件重建或覆盖现有 profile。默认包不带 `postinstall` 下载脚本，不会在安装时悄悄下载大模型。

## 自动兼容与缺项处理

`studio_compatibility` 自动读取本地 DSH 工具与 MCP 组件版本，并按实际服务选择执行方式。DSH 宿主版本和 DeepSeek 模型版本分别报告：支持已知的 DSH 0.2.1 API 家族；没有后台作业时改为有总时限的前台执行，没有图片附件服务时返回绝对路径样图链接。缺少原生用户问答服务时，正式制作暂停，保留项目。已知不兼容的主版本不会硬套旧接口，也不会自动升级用户的宿主。

模型信息优先使用宿主已公开的路由身份和模型目录，不读取凭据或调用额外模型。宿主不公开当前路由时，模型版本或视觉能力会显示未知；可在配置中补充 `modelRoute:{provider,model}`。`visionMode` 默认 auto；仅在用户已确认能力时覆盖为 supported 或 unsupported。不能根据“4.1 Flash”这个名称认定模型能够读图。无法确认视觉能力时，可以直接调用本地图生模型或静态重建；语义细节使用用户描述或其已有本地视觉项目。

`studio_create` 返回从需求到交付的流程能力报告；`studio_workflow` 可再次读取每个阶段的缺项和准备动作。librosa 缺失时，`studio_setup(backend:media)` 可在专用环境准备已登记版本，不修改用户现有 Python。报告中的 declared 表示已经发现能力声明，不能理解为实机测试通过。

第一次对话可以说：

> 使用本地三维工作室。先识别我的硬件和已有项目，缺少必要能力再准备。帮我做一个科幻维修机器人，先给基础模型样例，再问我是否有特别需求。

若 Blender 尚未安装，插件会明确报告需要配置的路径。Blender 可使用其官方安装版或便携版；本插件不自行执行系统级安装。Blenderwright 源码和 Python 依赖可以通过 `studio_setup` 获取。之后每次制作使用专用的空白 Blender 进程，动态加载已有 addon，不更改用户的 Blender 偏好或占用其已有工程。

## 可选配置

参照 [配置示例](examples/profile.patch.yml)，在现有 profile 的补丁中覆盖 `local-3d-studio` 这一行的 config。路径必须是实际绝对路径；**只复制需要的字段，避免覆盖原有配置。**

- `dataRoot`：项目、修订历史、托管依赖的专用目录。
- `projectRoots` / `preferredProjects`：本地项目发现范围和优先目录。
- `inputRoots`：允许读取的参考素材目录。默认包含工作目录、桌面和 DSH 附件目录。
- `blender` / `ffmpeg` / `ffprobe` / `colmap`：自动发现失败时指定 `.exe` 或可执行文件。
- `aiPython`：已有模型环境的 Python；`blenderwrightPython`：已有 Blenderwright 环境。
- `mediaPython`：用户已有、包含 librosa 的独立环境；也可用 `studio_setup(media)` 准备。
- `modelRoute` / `visionMode`：宿主没有公开当前模型元数据时的可选补充；不填写 API Key。
- `triposrWeights` / `hunyuanWeights`：已有本地权重目录。
- `comfyuiUrl` / `comfyuiWorkflow`：现有本地 ComfyUI 服务和 API 格式工作流。只允许回环地址，不接付费 endpoint。
- `skillPaths`：已有 grilling、ffmpeg 等 skill 的 `SKILL.md` 路径，按需读取，不复制或重新安装其整个项目。
- `taskTimeoutMinutes`：一次任务的总时限，默认 180 分钟；`maxFrames` 默认 3600。
- `hunyuanPaint`：默认 false。PBR 还需要上游文档所列扩展及本地辅助权重；不要在硬件未满足时开启。

硬件识别优先使用 `nvidia-smi` 的显卡型号和独立显存，其他平台尽量识别名称。可靠显存不可得时记录 null，不用共享内存或 WMI 32 位 AdapterRAM 冒充独立显存。模型选择以当前可用显存收缩；未知时默认 Blender 保守路线。

## 工具与制作过程

`studio_compatibility` → `studio_create` → `studio_workflow` → `studio_discover` / `studio_setup` → `studio_guides` / `studio_catalog` → `studio_plan` → `studio_run(preview)` → `studio_samples` → `studio_review` → `studio_run(build)`。

特别需求走 `studio_interview` / `studio_confirm_requirements`；修改后创建新修订版。方案格式见 [plan-format](recipes/plan-format.md)。长任务使用 DSH 后台作业、完成事件、取消和输出工具；插件不安排无限轮询。`studio_status` 读取状态，`studio_cancel` 停止本插件所属任务，`studio_recover` 在异常退出后恢复草稿，不自动续渲。

输出在 `dataRoot/p_<项目编号>/revision-N/` 下，包含方案、日志、预览、工程、模型和用户要求的视频。旧版本保留。素材按原样复制，不移动用户原文件；GLB 更适合带贴图导入，依赖外部贴图的 OBJ / glTF 请通过本地项目适配器完整准备。

请求动画时，`studio_create(outputs:["model","animation"])` 的后续方案必须包含视频和多帧；请求正式效果图时添加 render-images，方案必须列出 `artifacts.renders`。样例必须保留真实 .blend 工程，最终图片、模型与视频必须分别生成；概念图、拍点 JSON 或低分辨率预览不能替代正式交付。

## Three.js 模型通道

没有 Blender 也能处理现成模型：`studio_three` 用 Three.js 与 glTF 读写 GLB/GLTF，做查看、修改和预览。

| action | 作用 | 是否需要 Blender |
| --- | --- | --- |
| `setup` | 把 `three` 与 `@gltf-transform/core`、`extensions`、`functions` 安装到 `<dataRoot>/_dependencies/nodejs`，隔离、不写用户环境 | 否 |
| `demo` | 用 Three.js 现场生成示例 GLB（立方体/球体/地面），可验证通道 | 否 |
| `generate` | 按 `spec.objects`（box / sphere / cylinder / cone / torus / plane 组合）程序化生成 GLB，自动配地面与尺寸 | 否 |
| `inspect` | 报告节点、网格图元、材质、贴图数量、动画与包围盒 | 否 |
| `edit` | 按 `ops` 修改后导出新 GLB，并可同时生成 `.viewer.html` | 否 |
| `viewer` | 生成单文件 HTML 预览页，three.js 运行时已内嵌，离线可看，可旋转缩放 | 否 |
| `render` | 用无头 Chrome 打开预览页，按 `views`（front/back/left/right/top/iso）截图成 PNG | 否 |

`spec` 形如：

```json
{ "name": "Bookshelf", "ground": true,
  "objects": [
    { "type": "box", "size": [1.2, 0.04, 0.36], "position": [0, 1.78, 0], "color": "#8a5a33" },
    { "type": "cylinder", "radius": 0.2, "height": 1.4, "position": [0, 0.7, 0], "color": "#4f7fd9" }
  ] }
```

`ops` 支持 `transform`（平移/旋转/缩放）、`material`（颜色、金属度、粗糙度、透明度、自发光、双面）、`rename`、`remove`、`duplicate`、`scaleTo`、`center`。材质既可按名称也可按从 0 开始的序号指定。`scaleTo` 按**最长边**缩放到指定尺寸（不是按高度；要指定高度请换算 `size = 最长边 / 当前高度 × 目标高度`）。改写默认输出 `<原名>.edited.glb`，不覆盖原模型；预览页把模型与 three.js 运行时都以 base64 内嵌，断网可看。

`render` 默认输出到 `<预览页同名>-views/`，每个视角一张 1280×900 PNG；它用的是无头 Chrome（优先 `channel=chrome`，可用 `STUDIO_CHROME_CHANNEL=msedge` 切换）加载本地预览页，不联网、不依赖 Blender。没有安装 Playwright 或 Chrome 时会明确报错，而不是静默跳过。

`viewer` 生成的 HTML 已把 three.js 运行时（含 OrbitControls、GLTFLoader，约 760KB）内嵌，模型以 base64 内嵌，断网也能打开；文件会因此比 0.2.x 的 40KB 预览页大一些。

## 先探测再选路线

`studio_probe` 每次调用都实测本机，不缓存：

- 逐个探测 Blender、COLMAP、FFmpeg、FFprobe、Python 的真实路径与版本；
- 访问 `comfyuiUrl`（默认 `http://127.0.0.1:8188`）的 `/system_stats`，并扫描常见 ComfyUI 目录里的 `main.py`；
- 给出 `pipeline`：`modeling` 在 Blender 可用时是 `blenderwright`，否则是 `three-procedural`；`reconstruction` 需要 COLMAP；`ai3d` 需要 ComfyUI 可达。

插件系统提示里写死了这条规则：Blender 可用就走 Blenderwright；不可用就用 `studio_three action=generate` 程序化建模、`action=render` 出多视角图，并在交付时说明这次实际用了哪条路线，不把截图说成 Blender 渲染。



依赖安装是本机网络操作（几十 MB），首次使用前显式调用一次 `setup`。模型解析与写回在独立子进程中完成，不启动浏览器、不联网、不读取 Key。

> **0.2.1 修复**：① `viewer` / `edit` 省略 `outputPath` 时的默认路径现在正确返回字符串（此前会把 Promise 当路径传给 worker，报 `The "path" argument must be of type string`）；② `setup` 在 Windows + Node 24 下改为经 `cmd.exe /d /s /c` 调用 `npm.cmd`，修掉 `spawn EINVAL`；③ 依赖安装与运行统一使用活动 `dataRoot`，不再和用户工作区下的同名目录混淆。

> **0.3.1 修复**：① 程序化 `cylinder` 现在真正读取 `radius`（此前只认 `radiusTop/radiusBottom`，传 `radius` 会得到默认 0.5 的粗柱子）；② 多视角截图的取景距离从「最长边 × 2.2」收紧到 × 1.6，模型不再缩在画面中央一小块。

## 当前边界与验证状态

- 单元测试已在本机复验：`node --test tests/core.test.mjs` 共 23 项全部通过（含 Three.js 操作参数、程序化 spec 与视角白名单），`node --check index.mjs`、`src/three.mjs`、`src/detect.mjs`、`src/render.mjs`、`workers/model_edit.mjs` 通过。
- 全链路已在本机跑通（无 Blender）：`studio_three action=generate` 按 spec 生成书架 `bookshelf.glb`（64,520 字节、33 个网格），`action=render` 出 3 张 1280×900 视图（front 26,290 / right 18,224 / iso 70,467 字节），`action=viewer` 生成离线单文件预览页；截图人工核验结构正常。
- Three.js 通道旧数字仍有效：`demo` 生成 28,800 字节 GLB；`inspect` 读到 4 个节点、3 个网格、3 个材质、包围盒 4×1.05×4；`edit` 完成缩放、居中、旋转、改色、重命名、复制并导出 28,304 字节 GLB。
- 插件已通过 `plugin_manager install_bundle` 装进本机 DSH Desktop（`0.2.1-rc.2`），21 个 `studio_*` 工具注册成功并可调用；宿主插件警告仅为无关的 `dsh-office-tools` 重复注册。
- 本机探测结果（`studio_probe` 实测）：Blender、COLMAP 未安装；FFmpeg/FFprobe 9.0.2、Python 3.14.7、Git 可用；ComfyUI 不可达（`fetch failed`，8188 无监听）；GPU 为 Intel UHD、内存 16GB，硬件档位保守为 CPU。因此本机建模路线自动落到 `three-procedural`；Blender/COLMAP/ComfyUI 一旦装好，`studio_probe` 会在下一次调用时直接显示可用并切换路线，不需要改配置。
- 本机只有 Intel 核显、无可靠独显数据，`studio_hardware` 给出 `tier: unknown` 的 CPU 保守方案；模型视觉能力未公开（`vision: null`）。
- 官方接口参考为 DSH `0.2.1-rc.2`、Blenderwright `2.3.0`；上游未来更改接口时应调整薄适配层。
- 本地模型首次安装可能需要 C++ / CUDA 编译依赖；缺少管理员工具链时停止并给出原因，不修改系统配置。
- ComfyUI 需已有可运行服务、节点、模型和 API 工作流。克隆其源码不等于拥有所有社区工作流；自定义节点和权重需要明确选择后准备。
- ComfyUI 取消使用新版本的 `/api/jobs/{id}/cancel` 单任务接口；旧服务缺少该接口时会要求用户在其界面确认状态，不调用会误停其他任务的全局中断。
- COLMAP 静态重建需要有重叠视角、可匹配纹理和可用的编译版；其常规稠密重建需要相应 CUDA 能力。不会把重建失败自动包装成成功。
- 真实尺寸、机械装配和复杂角色变形不能仅以样图判断。用户如需这些验收，应另行明确检查范围。

## 可申请的一次离线检查

先取得用户批准，再运行：`node --test tests/core.test.mjs`、JavaScript 语法检查、Python 语法检查和安装包结构核对。均不需要模型 Key、模型权重、渲染或 GPU。实际 DSH 安装和 Blender/模型链路验收单独批准。安装第三方依赖不等于批准这些检查。

这一次范围也可统一执行 `python scripts/offline_check.py`：各检查只运行一次，生成独立报告，不联网、不安装、不启动 DSH、Blender 或模型。失败后修复不自动复验。

插件自己的胶水代码为 MIT。各第三方项目、模型权重和用户素材保留原有许可。
