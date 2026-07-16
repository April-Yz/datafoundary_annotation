# 565h 后机箱与异常简化标注工具

此分支仅用于 **565h 版本之后新增的数据**，只标注：

- 大机箱 / 小机箱（必选，无默认值）
- `B bad_demo`：视频损坏或无法判断
- `C camera_shift`：主视角严重偏移、看不到关键区域
- `D 是否跳变`：动作或画面存在明显跳变

本分支不显示、不修改、也不保存任务名称、任务片段、Subtask 或断点。

## 获取正确分支

首次下载：

```bash
git clone -b chassis-anomaly-only --single-branch \
  https://github.com/April-Yz/datafoundary_annotation.git
```

以后更新：

```bash
cd datafoundary_annotation
git branch --show-current
git pull --ff-only
```

`git branch --show-current` 必须输出：

```text
chassis-anomaly-only
```

565h 以前需要任务名称/Subtask 标注的数据仍使用 `main` 完整版，不要混用。

## 运行

将本分支中的网页代码覆盖到待标注 package；不要覆盖 package 中已有的：

- `items.jsonl`
- `videos/`
- `previews/`
- `annotations.jsonl`
- `annotations_latest.json`

启动：

```bash
PACKAGE_DIR=/path/to/annotation_package

python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080
```

浏览器打开 `http://127.0.0.1:18080/`。

## 保存格式

每条记录严格保存六个字段：

```json
{
  "episode_index": 20557,
  "demo_timestamp": "YYYYMMDDHHMMSS",
  "camera_shift": false,
  "bad_demo": false,
  "是否跳变": false,
  "chasis_label": "large"
}
```

`chasis_label` 只允许 `large` 或 `small`。即使选择 `bad_demo`，仍必须选择机箱。

结果文件：

- `annotations.jsonl`：每次保存的追加历史
- `annotations_latest.json`：每个 timestamp 的最新结果

更新 Git 代码不会覆盖上述结果，因为结果位于数据 package，而不是 Git 代码目录。详细操作见 `ANNOTATOR_RUN_GUIDE.zh.md`。
