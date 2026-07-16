# 565h 后简化标注运行指南

## 1. 下载代码

```bash
git clone -b chassis-anomaly-only --single-branch \
  https://github.com/April-Yz/datafoundary_annotation.git

cd datafoundary_annotation
git branch --show-current
```

最后一条命令必须显示 `chassis-anomaly-only`。如果显示 `main`，说明下载了错误版本。

## 2. 更新已有代码

```bash
cd datafoundary_annotation
git switch chassis-anomaly-only
git pull --ff-only
```

标注 JSON 位于数据 package，更新代码不会覆盖结果。不要把原始数据包重新解压到已经标注过的目录，否则原始包中的空 JSON 可能覆盖结果。

## 3. 准备 package

package 至少应有：

- `items.jsonl`
- `videos/`
- `previews/`
- `package_manifest.json`

把本仓库以下文件复制到 package 根目录：

```bash
CODE_DIR=/path/to/datafoundary_annotation
PACKAGE_DIR=/path/to/annotation_package

cp "$CODE_DIR"/index.html \
   "$CODE_DIR"/app.js \
   "$CODE_DIR"/style.css \
   "$CODE_DIR"/label_config.json \
   "$CODE_DIR"/annotation_server.py \
   "$CODE_DIR"/README.zh.md \
   "$CODE_DIR"/ANNOTATOR_RUN_GUIDE.zh.md \
   "$PACKAGE_DIR"/
```

上述命令不会复制或删除 `annotations*.json*`。

## 4. 启动

只需要 Python 3.8+ 和能播放 H.264 MP4 的现代浏览器，不需要 pip 安装依赖。

```bash
PACKAGE_DIR=/path/to/annotation_package

python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080
```

同一台电脑打开：

```text
http://127.0.0.1:18080/
```

如果服务在远程主机，本地执行：

```bash
ssh -N -L 8002:127.0.0.1:18080 user@server
```

再打开 `http://127.0.0.1:8002/`。不要用 `file://` 打开网页，否则无法可靠保存和拖动视频。

## 5. 标注操作

- `6`：大机箱
- `7`：小机箱
- `B`：bad demo
- `C`：主视角严重偏移
- `D`：是否跳变
- `Enter`：保存并进入下一条
- `← / →`：上一条 / 下一条
- `Space`：播放 / 暂停
- `, / .`：前后移动一帧
- `< / >`：前后移动十帧
- `[ / ]`：降低 / 提高播放速度

每条必须选择机箱。三个异常默认均不勾选，确认视频正常时只需选择机箱并按 Enter。

## 6. 保存与恢复

每次保存都会同时更新：

- `annotations.jsonl`：追加历史，重复标注同一条也会保留
- `annotations_latest.json`：每个 timestamp 仅保留最后一次结果

关闭网页或服务器不会丢失已成功保存的结果。重新启动后，页面会从 `annotations_latest.json` 恢复机箱和 B/C/D。

本分支每条记录严格只有：

```text
episode_index, demo_timestamp, camera_shift, bad_demo, 是否跳变, chasis_label
```

旧记录即使含有 `task_name` 或 `subtask_breakpoints`，加载后重新保存时也会被服务端剥离。

## 7. 交付

标注结束至少交回：

- `annotations.jsonl`
- `annotations_latest.json`

建议同时交回：

- `items.jsonl`
- `package_manifest.json`

不需要交回视频。
