# 本地三维工作室编排

仅在用户要求三维建模、参考复刻或三维动画时启动此流程。沿用当前 DeepSeek，不创建新的模型连接，不调用收费图像/三维服务。此插件串联现成项目，不实现新的建模引擎。

## 兼容与能力
先用 `studio_compatibility` 自动读取本地 DSH 工具/MCP 组件版本和可用服务。模型版本和 DSH 版本是两回事；不按 Flash、4.1 或日期字符串推断视觉能力。工具返回当前路由未公开或 vision:null 时就保持未知，不宣称看懂图片。可直接调用本地图生模型或静态重建；需要语义解释时只补充询问用户未给的描述，或选用户已有本地视觉项目，不创建新的付费模型连接。

没有后台服务自动前台执行并遵守总时限；没有图片附件服务输出绝对路径样图链接；缺少原生用户问答服务时保留项目并说明，不能用模型自填字段替代人工批准。已知不兼容主版本停止制作，保留当前 profile，不擅自升级宿主。

`studio_create` 已返回流程能力报告；必要时用 `studio_workflow` 读取各阶段缺项及准备动作。该报告只描述本地声明，不是测试通过。缺少已登记项目时继续准备与编排，不把“需要安装”当作任务结束；系统级工具、未知自定义节点或不兼容硬件需如实报告。

## 最重要的入口
普通一句话请求：`studio_create(intake: quick)` → 发现/准备现成工具 → 查询参数与现成工作流 → 保存基础建模方案 → 执行 preview → 展示样例 → `studio_review`。先提供真实基础模型，再询问特别需求和精细化。不要把用户挡在漫长访谈前；也不要给没要求动画的用户默认制作长视频。

`outputs` 默认只有 model；用户明确要求动画时添加 animation，要求正式效果图时添加 render-images。只在用户明确要求精细制作时填 detailLevel:detailed。用户后续改变交付要求时，用 `studio_note_requirements` 的 facts.outputs 与 evidence 记录；不能遗漏动画，也不能擅自扩大交付范围。

明确特别需求：`studio_create(intake: interview)` → 逐轮 `studio_interview` → `studio_confirm_requirements` → 方案和样例。已有项目收到新要求时继续该项目。每轮只问当前能决定、会改变结果的 1—3 个问题，给推荐选项；保留答案，明确区分假设、默认值和用户决定。

用户已在原话里说明用途、风格、尺寸或修改决定时，先用 `studio_note_requirements` 记录事实及原话，不要再问一次。用户主动更正旧决定也用该工具；不要以“已经问过”为由拒绝更正。

## 工具与 skill 复用顺序
1. `studio_discover`：用户指定项目、用户 local-3d.adapter.json、已识别本地项目优先于插件托管副本。按用途、输入、显存和输出类型选择，不能仅凭仓库名称就声称更优。
2. 缺少必要能力才 `studio_setup`。展示精确来源和隔离安装范围；需要模型权重时另明确选择。安装不授权测试、渲染、上传或付费。
3. `studio_guides(blender)` 读取 Blenderwright 自带 expert prompts；`studio_guides(skills)` 读取用户配置的 grilling、ffmpeg 等技能。引用来源，不照搬技能中的收费服务、无界循环、自动检查或派生代理要求。
4. `studio_catalog` 读取真实工具名，再针对名称查询参数。用既有结构化建模、材质、灯光、骨骼、动画、导出工具编排；不使用原始 Python、删除或清空场景工具。
5. 图片使用 `studio_reference`，视频先抽帧再理解。静态环绕可以走现成 COLMAP；动态视频默认视觉与动作近似复刻，并说明不可见结构和遮挡的不确定性。现有视频生成工作流不等同于获得真实三维资产。
6. 不需要图生模型权重时，直接通过 Blenderwright 创建模型及程序化细节。需要生成式资产时，优先可用的本地适配器、TripoSR、Hunyuan 或 ComfyUI 工作流。缺少权重时明确提示，不能偷偷转云端。

## 制作与调整
用 `studio_plan` 保存 previewSteps 和 buildSteps。两阶段步骤都使用实际工具 schema。样例阶段做模型轮廓、结构比例和代表材质，渲染 1—6 张图并保存 previewScene；正式阶段从该工程继续细化、动画、渲染和导出。图片/视频输入也必须先展示样例。

完整格式可通过 `studio_guides(topic:plan)` 读取。previewScene 必须为真实 .blend；不能只生成二维概念图后声称已经建模。请求正式效果图时声明 artifacts.renders，请求动画时声明 artifacts.video 并使用多帧；最终交付包含这些文件。插件启动专用场景时应用 render 的分辨率、帧率和帧数；后续工具参数保持一致，不暗中改变用户批准的规格。

样例生成后先 `studio_samples` 展示，再 `studio_review`。用户要求精细化或提出新需求时回到逐轮访谈；摘要确认后修改方案，生成新样例。用户批准当前样例后才执行 build。批准绑定修订版、方案、样图和预览工程；修改使旧批准失效。失败后不得自行反复重跑或宣称通过验收。

使用 Harness 原生后台作业状态和完成事件，不进行无限轮询。任务取消仅停止工作室专用 Blender，不停止用户已有服务。交付 `.blend`、模型文件和用户要求的视频；还应说明已完成、近似部分及未做的检查。

音乐需要先获得可解码音频，再使用现成 librosa 标记候选拍点。重音、乐句和动作完成时刻由制作方案解释；不得把自动 BPM 当作已经听审确认。

librosa 缺失时通过 `studio_setup(backend:media)` 准备专用环境，或复用用户配置的 mediaPython；不在用户原有 Python 中无关升级。音乐分析完成后读取 music-timeline.json，再把候选时间转成实际关键帧/镜头切点；只有生成拍点 JSON 不算完成卡点动画。保留没有听审和未验收的说明。

## 格式
方案对象必须包括 title、summary、render、previewSteps、buildSteps、artifacts。render 是 {width,height,fps,frames}；一句话模型默认 frames:1。artifacts 是 {previews:["{previewDir}/front.png"],previewScene:"{previewDir}/sample.blend",scene:"{buildDir}/final.blend",models:["{buildDir}/model.glb"]}；需要动画才添加 video。每个工具步骤为 {kind:"blender",tool:"真实工具名",args:{真实参数},reason:"制作目的"}。其他种类和详细格式见 recipes/plan-format.md。

路径用 {previewDir}、{buildDir}、{assetDir}、{input:0} 等占位符；始终保存文件到当前项目。预览阶段保存的工程在正式制作开始时自动加载，因此正式步骤从同一模型继续细化。先通过现成工具保存工程，不能仅返回一张看起来像三维的图片。
