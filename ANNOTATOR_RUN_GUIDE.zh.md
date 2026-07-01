# 任务名称标注包运行指南

本文档给标注员或运行主机使用。你会收到一个已经构建好的 annotation package，通常是 `.tar`、`.tar.gz` 或 `.zip`。标注员只需要在有浏览器的机器上启动一个本地 Python 服务，然后打开网页标注。

## 1. Package 里应该有什么

解压后目录里至少应该包含：

- `index.html`
- `app.js`
- `style.css`
- `label_config.json`
- `annotation_server.py`
- `items.jsonl`
- `videos/`
- `previews/`
- `package_manifest.json`

标注过程中会新增或更新：

- `annotations.jsonl`
- `annotations_latest.json`

这两个就是最后需要交回来的核心结果文件。

## 2. 环境要求

运行标注服务的主机需要：

- Python 3.8+，推荐 Python 3.10+
- Chrome / Edge / Safari / Firefox 任一现代浏览器
- 能播放 H.264 MP4
- package 所在磁盘可写，因为保存结果会写入 `annotations.jsonl` 和 `annotations_latest.json`

不需要安装 PyTorch、pandas、LeRobot，也不需要联网。

如果只是运行已经打好的 package，通常不需要 `pip install` 任何东西。

## 3. 解压 package

如果收到的是 zip：

```bash
mkdir -p ~/annotation_packages
unzip /path/to/task_annotation_package.zip -d ~/annotation_packages/
```

如果收到的是 tar.gz：

```bash
mkdir -p ~/annotation_packages
tar -xzf /path/to/task_annotation_package.tar.gz -C ~/annotation_packages/
```

如果收到的是 tar：

```bash
mkdir -p ~/annotation_packages
tar -xf /path/to/task_annotation_package.tar -C ~/annotation_packages/
```

假设解压后的 package 路径是：

```bash
/home/user/annotation_packages/task_annotation_package
```

下面命令里的路径都替换成你自己的 package 路径。

### 可选：覆盖最新版网页代码补丁

如果同时收到了 `annotation_tool_v13_overlay_patch_*.tar.gz`，请在解压数据包后覆盖一次网页代码：

```bash
PACKAGE_DIR=/home/user/annotation_packages/task_annotation_package
tar -xzf /path/to/annotation_tool_v13_overlay_patch_*.tar.gz -C "$PACKAGE_DIR"
```

这个补丁只覆盖网页代码、说明文档和 `annotation_server.py`，不会修改：

- `videos/`
- `items.jsonl`
- `annotations.jsonl`
- `annotations_latest.json`

覆盖后页面应该显示 `机箱类型 Chassis（必选，无默认）`。

## 4. 启动标注网页

在运行主机上执行：

```bash
PACKAGE_DIR=/home/user/annotation_packages/task_annotation_package

python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080 \
  --annotator your_name
```

然后在同一台机器浏览器打开：

```text
http://127.0.0.1:18080/
```

`--annotator` 请改成自己的名字或编号，例如：

```bash
--annotator annotator_A
```

这个字段会写入每条标注记录，方便后续追踪。

## 5. 如果数据在远程服务器，浏览器在本地电脑

在远程服务器上启动：

```bash
PACKAGE_DIR=/path/on/server/task_annotation_package

python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080 \
  --annotator your_name
```

然后在本地电脑开 SSH 端口转发：

```bash
ssh -N -L 8002:127.0.0.1:18080 user@server
```

本地浏览器打开：

```text
http://127.0.0.1:8002/
```

不要直接用 `file://.../index.html` 打开网页，因为这样不能保存标注。

## 6. 可选：用 tmux 保持服务运行

如果在服务器上运行，建议用 tmux：

```bash
tmux new -s task_annotation

PACKAGE_DIR=/path/to/task_annotation_package
python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080 \
  --annotator your_name
```

退出 tmux 但保持服务运行：

```text
Ctrl-b 然后按 d
```

重新进入：

```bash
tmux attach -t task_annotation
```

停止服务：

```text
Ctrl-c
```

## 7. 检查服务是否正常

启动后可以检查：

```bash
curl http://127.0.0.1:18080/api/health
```

正常会返回类似：

```json
{"ok": true, "package_dir": "..."}
```

如果浏览器里视频不能拖动进度条，通常是没有通过 `annotation_server.py` 打开，或者端口转发不正确。

## 8. 标注结果保存在哪里

每次点击 `Enter 保存并下一个`，服务端会写两个文件：

当前版本每条保存结果都必须包含：

- `chassis_type`：`large_case` 或 `small_case`
- `chassis_label`：`大机箱` 或 `小机箱`

如果页面提示“请先选择机箱类型”，需要先选择大机箱/小机箱后再保存。

### `annotations.jsonl`

追加式流水日志。每次保存都会新增一行，即使同一个 timestamp 被反复保存，也都会保留历史。

用途：

- 追踪标注过程
- 出错时恢复历史
- 审计谁在什么时候改过

### `annotations_latest.json`

每个 timestamp 只保留最后一次保存结果。

用途：

- 后续正式回写/合并时优先使用
- 标注员继续标注时，页面会读取它恢复上次保存状态

## 9. 中途暂停与继续

可以随时停止服务。下次用同一个 package 目录重新启动即可。

只要 `annotations_latest.json` 还在，之前保存的标注会自动加载。

注意：

- 不要删除 `annotations.jsonl`
- 不要删除 `annotations_latest.json`
- 不要移动 package 内部的 `videos/` 和 `previews/`

## 10. 最后需要交回什么

标注完成后，请至少交回：

- `annotations.jsonl`
- `annotations_latest.json`

建议同时交回：

- `package_manifest.json`
- `items.jsonl`

不用交回视频，除非另行要求。

推荐打包命令：

```bash
PACKAGE_DIR=/home/user/annotation_packages/task_annotation_package
ANNOTATOR=your_name
OUT=annotation_result_${ANNOTATOR}_$(date +%Y%m%d_%H%M).tar.gz

cd "$PACKAGE_DIR"
tar -czf "$OUT" \
  annotations.jsonl \
  annotations_latest.json \
  package_manifest.json \
  items.jsonl

echo "结果包: $PACKAGE_DIR/$OUT"
```

如果担心 `annotations.jsonl` 或 `annotations_latest.json` 不存在，可以先检查：

```bash
ls -lh annotations.jsonl annotations_latest.json
python3 -m json.tool annotations_latest.json >/dev/null && echo "annotations_latest.json OK"
```

## 11. 常见问题

### 页面打开了但保存失败

请确认你是通过 `http://127.0.0.1:端口/` 打开的，不是 `file://`。

### 视频不能拖进度条

请确认服务是用 `annotation_server.py` 启动的。这个服务支持 HTTP Range，普通静态服务可能导致 MP4 不能正常 seek。

### 页面看起来还是旧版本

刷新浏览器页面。必要时强制刷新：

- macOS：`Cmd + Shift + R`
- Windows/Linux：`Ctrl + F5`

### 端口被占用

换一个端口：

```bash
python3 annotation_server.py --package-dir "$PACKAGE_DIR" --host 127.0.0.1 --port 18081 --annotator your_name
```

浏览器打开：

```text
http://127.0.0.1:18081/
```
