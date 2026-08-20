# 文迹 Wenji

文迹是一款面向 Windows 的本地文件名与内容搜索工具。它在电脑上建立全文索引，支持 Office、WPS、代码和常见文本文件；索引与文件内容不会上传到网络。

## 功能

- 同时搜索文件名和文件内容，显示命中片段与位置。
- Word、Excel、PowerPoint 及 WPS 常用格式。
- Python、Java、JavaScript、TypeScript、C/C++、C#、Go、Rust、SQL 等代码文件。
- TXT、Markdown、Log、JSON、YAML、XML、INI、TOML、CSV 等文本文件。
- 文件新增、修改或删除后自动增量更新索引。
- 按文件类型、命中范围、修改时间筛选，并按相关度、时间、名称或大小排序。
- 右键打开、定位、复制路径，以及系统托盘和全局快捷键。

## 搜索语法

```text
"设备检修" -作废
name:报告 ext:docx
content:报警 type:office
```

- 双引号表示精确短语。
- `-关键词` 排除包含该关键词的结果。
- 支持 `name:`、`content:`、`ext:`、`type:` 限定范围。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm install
npm run dev
```

## 构建 Windows 安装包

```powershell
npm run dist
```

构建结果位于 `release` 目录，包括 NSIS 安装版和免安装版。

## 定位打开

- Word/WPS 文字：查找并选中命中文本。
- Excel/WPS 表格：跳转到命中工作表和单元格区域。
- PowerPoint/WPS 演示：跳转到命中幻灯片。
- 文本和代码：使用 Windows 记事本跳转到命中行。

Office/WPS 未安装或自动化失败时，文迹会回退到系统默认打开方式。

## 隐私

文迹不包含云端服务。搜索目录、索引和解析出的文字只保存在本机 Electron `userData` 目录。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交代码前请确认 `npm run build` 能够通过。

## License

[MIT](LICENSE)
