import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { inside } from './store.mjs';
import { inventory } from './dependencies.mjs';

export async function videoFrames(input, output, project, config, context, count = 8) {
  const { ffmpeg, ffprobe } = project.hardware.tools;
  if (!ffmpeg || !ffprobe) throw new Error('视频输入需要本地 FFmpeg 和 FFprobe；请配置其可执行文件路径。');
  if (!Number.isInteger(count) || count < 2 || count > 48) throw new Error('抽帧数量必须为 2—48。');
  await fs.mkdir(output, { recursive: true });
  const info = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { ...context, timeoutMs: 15000 })).stdout);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长；请换用能正常解码的视频文件。');
  await run(ffmpeg, ['-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', input,
    '-vf', `fps=${count}/${duration},scale=1024:-2`, '-frames:v', String(count), path.join(output, 'frame-%03d.jpg')],
    { ...context, timeoutMs: Math.min(300000, config.taskTimeoutMinutes * 60000) });
  return (await fs.readdir(output)).filter(f => /^frame-\d+\.jpg$/.test(f)).sort().map(f => path.join(output, f));
}

export async function reconstructVideo(step, project, config, context) {
  const colmap = project.hardware.tools.colmap;
  if (!colmap) throw new Error('静态视频重建需要可执行的 COLMAP；缺少编译好的程序时可选择已有的本地重建项目，或切换到近似场景复刻。');
  const base = step.output, images = path.join(base, 'images'), sparse = path.join(base, 'sparse'), dense = path.join(base, 'dense');
  await videoFrames(step.input, images, project, config, context, step.count || 32);
  await fs.mkdir(sparse, { recursive: true }); await fs.mkdir(dense, { recursive: true });
  const db = path.join(base, 'database.db');
  const calls = [
    ['feature_extractor', '--database_path', db, '--image_path', images],
    ['sequential_matcher', '--database_path', db],
    ['mapper', '--database_path', db, '--image_path', images, '--output_path', sparse],
    ['image_undistorter', '--image_path', images, '--input_path', path.join(sparse, '0'), '--output_path', dense, '--output_type', 'COLMAP', '--max_image_size', '1600'],
    ['patch_match_stereo', '--workspace_path', dense, '--workspace_format', 'COLMAP', '--PatchMatchStereo.geom_consistency', 'true'],
    ['stereo_fusion', '--workspace_path', dense, '--workspace_format', 'COLMAP', '--input_type', 'geometric', '--output_path', path.join(dense, 'fused.ply')],
    ['poisson_mesher', '--input_path', path.join(dense, 'fused.ply'), '--output_path', path.join(base, 'mesh.ply')],
  ];
  for (const args of calls) await run(colmap, args, { ...context, timeoutMs: config.taskTimeoutMinutes * 60000 });
  return [path.join(base, 'mesh.ply')];
}

export async function ffmpegStep(args, project, root, context) {
  const binary = project.hardware.tools.ffmpeg; if (!binary) throw new Error('未找到 FFmpeg。');
  const valued = new Set(['-framerate', '-r', '-i', '-c:v', '-c:a', '-crf', '-preset', '-pix_fmt', '-movflags', '-map', '-b:a', '-ar', '-ac', '-ss', '-t', '-vf', '-af', '-filter_complex']);
  const switches = new Set(['-shortest', '-an', '-vn']);
  for (let i = 0; i < args.length - 1; i++) {
    if (switches.has(args[i])) continue;
    if (!valued.has(args[i]) || i + 1 >= args.length - 1) throw new Error('FFmpeg 步骤只接受本地编码/合成参数；其他媒体流程请使用已登记适配器。');
    const key = args[i], value = args[++i];
    if (key === '-i' && (!path.isAbsolute(value) || !inside(root, value))) throw new Error('FFmpeg 输入必须是当前项目内的绝对路径。');
  }
  if (args.some(s => /https?:|ftp:|tcp:|udp:|concat:|-y$/.test(s))) throw new Error('本地媒体步骤禁止网络协议和覆盖已有文件。');
  for (const arg of args) {
    if (path.isAbsolute(arg) && !inside(root, arg)) throw new Error('FFmpeg 只处理当前项目文件。');
    if (/(?:amovie|movie|sendcmd|zmq|fontfile)\s*[:=]/i.test(arg)) throw new Error('该滤镜可访问额外资源，当前编排不接受。请使用已登记的本地媒体适配器。');
  }
  const target = args.at(-1);
  if (!target || !path.isAbsolute(target) || !inside(root, target)) throw new Error('FFmpeg 最后一个参数必须是当前项目内的绝对输出路径。');
  await run(binary, ['-nostdin', '-n', '-protocol_whitelist', 'file,pipe', ...args], context);
  return [target];
}

export async function musicBeats(input, output, project, config, context) {
  const binary = project.hardware.tools.ffmpeg;
  if (!binary) throw new Error('音乐分析需要 FFmpeg；不直接处理 NCM。');
  await fs.mkdir(output, { recursive: true });
  const wav = path.join(output, 'analysis.wav');
  await run(binary, ['-nostdin', '-n', '-i', input, '-vn', '-ar', '22050', '-ac', '1', wav], context);
  const target = path.join(output, 'music-timeline.json');
  const media = (await inventory(config)).projects.find(p => p.id === 'media');
  const python = config.mediaPython || media?.pythonPath || config.aiPython;
  await run(python, [fileURLToPath(new URL('../workers/music_beats.py', import.meta.url)), wav, target], context);
  return [target];
}
