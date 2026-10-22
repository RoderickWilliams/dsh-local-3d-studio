# 复用来源与版本记录

本插件没有复制三维模型、权重或上游建模引擎。打包时不包含 `.reference` 中用于了解接口的源码摘录。

- DSH 工具与原生用户交互：官方仓库 `deepseek-ai/deepseek-harness`，本次读取的工具包版本 `0.2.1-rc.2`。包格式为官方 `dsh.bundle`，连接器复用 `@deepseek-ai/dsh-mcp-client`。
- Blenderwright：官方维护仓库 `HoldMyBeer-gg/blenderwright`，本次读取 `pyproject.toml` 版本 `2.3.0`。工作流读取其现成 `prompts/workflows.py`；端口与独立进程适配为本插件的少量胶水代码。
- TripoSR：`VAST-AI-Research/TripoSR`。直接调用 `run.py` 及其本地权重参数，不重新实现网络或网格提取。
- Hunyuan3D 2.1：`Tencent-Hunyuan/Hunyuan3D-2.1`。薄适配器调用其 `Hunyuan3DDiTFlowMatchingPipeline` 和可选 PBR 管线。使用前遵守上游许可与环境要求。
- ComfyUI：`Comfy-Org/ComfyUI`。使用本机 HTTP / WebSocket API 与用户现有工作流；单任务取消参考其 `/api/jobs/{job_id}/cancel` 接口。
- COLMAP：官方 CLI 的特征提取、匹配、稀疏重建、稠密融合、网格化步骤。
- librosa：现成 `beat_track`、`onset_detect` 算法。结果标为候选，不冒充音乐听审结果。
- 音频隔离安装配方：`librosa==0.11.0`，来源 https://pypi.org/project/librosa/0.11.0/ ，保留其 ISC 和各依赖许可；本次没有实际安装。
- grilling：本机 `mattpocock-skills` 的逐轮决策树访谈方法。用户配置 skillPaths 后按需读取其已有文档，不在本包分发原技能。

`studio_setup` 获取项目后保存仓库 URL、实际 commit、隔离环境路径、安装时间，以及 `installed-packages.txt`。上游没有可复用锁文件时不伪称依赖完全锁定；不会无关升级用户已有环境。

已运行一次本插件的离线检查，结果见检查记录；没有运行上述第三方项目的测试、安装验收、渲染或模型推理。后续补充官方源码读取失败，因此新增兼容层仍以本地保存的官方接口参考为依据，不宣称验证了更新版本。
