# 编排方案格式

`studio_plan` 接收 JSON 对象；它描述现成工具调用，不是新的三维场景语言。

```json
{
  "title": "主体名称",
  "summary": "主体、风格、结构、材质、镜头与交付内容",
  "limitations": ["不可见背面采用合理推测"],
  "render": {"width": 1280, "height": 720, "fps": 24, "frames": 1},
  "previewSteps": [
    {"kind": "blender", "tool": "从 studio_catalog 选择实际工具", "args": {}, "reason": "先搭建主体框架"}
  ],
  "buildSteps": [
    {"kind": "blender", "tool": "从 studio_catalog 选择实际工具", "args": {}, "reason": "按用户批准的方向细化并导出"}
  ],
  "artifacts": {
    "previews": ["{previewDir}/front.png"],
    "previewScene": "{previewDir}/sample.blend",
    "scene": "{buildDir}/final.blend",
    "models": ["{buildDir}/model.glb"]
  }
}
```

上例是格式示意，工具名和参数必须先查目录，不能原样执行。需要动画时添加真实关键帧、渲染及合成步骤，并在 artifacts 中添加 `video`；只要求模型时保留单帧，不扩大范围。

步骤种类：
- `blender`：`tool` 为 Blenderwright 原始工具名或 `mcp__local3d__` 前缀名，`args` 为真实参数。
- `adapter`：`adapterId`、`input`（项目内参考路径）、`output`（项目内目录）、可选 `prompt`、`seed`。返回模型后使用 Blenderwright 导入并继续制作。TripoSR 默认产物 `{output}/0/mesh.glb`，混元默认 `{output}/mesh.glb`。
- `video_frames`：`input`、`output`、`count`（2—48），由 FFmpeg 完成。
- `music_beats`：`input`、`output`，现成 librosa 输出 `music-timeline.json`；需要 aiPython 已有 librosa。
- `ffmpeg`：`args` 数组，最后一项为项目内绝对输出路径；不覆盖已有文件，不接受网络 URL。

可用占位符：`{projectDir}`、`{revisionDir}`、`{previewDir}`、`{buildDir}`、`{assetDir}`、`{input:N}`。样例和正式制作分开目录，旧修订版保留。需要复用旧版本的工程时应在当前样例阶段通过项目内路径加载，并保存到新版本。

`previewScene` 为必填的 .blend 工程；概念图片不是基础模型。正式 `scene` 也必须为 .blend；`models` 至少包含一个模型文件。需要正式效果图时添加 `renders:["{buildDir}/beauty.png"]`，不能用低分辨率预览替代。需要动画时添加 `video:"{buildDir}/animation.mp4"` 并设置 frames>1；配套关键帧、动画渲染和 FFmpeg 合成步骤仍应先查真实工具参数。

音乐环境可用 `studio_setup(backend:media)` 隔离准备，或配置已有 `mediaPython`。先分析拍点，读取 JSON 后形成实际时间线步骤；不把拍点文件本身当作动画交付。
