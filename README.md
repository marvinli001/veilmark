# Veilmark · 图片版权水印工坊

显性水印、智能伪隐性水印、算法盲水印三合一的轻量 Web 工具。三种水印可以多选叠加，支持批量处理和多模板；导出时自动用本机 Ed25519 密钥签发版权证书（零配置，备份与恢复收在“高级”里），任何人都能离线核验。所有处理都在浏览器本地完成，部署为纯静态站点。

完整技术方案、算法评估与实测数据见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 快速开始

```bash
npm install
npm run dev              # http://localhost:3000
```

可选：下载 TrustMark 模型（启用“TrustMark / 双引擎”盲水印时才需要，约 64 MB）：

```bash
npm run models:trustmark
```

## 主要功能

- **三种水印**：显性（多图层、单点 / 平铺 / 斜带）、伪隐性（日常看不出，打印、缩放、调色后浮现）、盲水印（CDP 频域 + Adobe TrustMark）。
- **拖动即预览**：拖伪隐性参数时切到 WebGL2（2400×1600 单帧约 2 ms），拖显性图层参数时主线程直接重画，松手后再做全分辨率计算。
- **模板**：4 个只读起步模板（社媒分享、作品集防盗、打印防伪、证件/合同），自建模板可导入导出 JSON（默认去除私钥）；缩略图条里每张图可以指定自己的模板。
- **手机 / iPad**：竖屏上图下参数、横屏左右分栏；全程触屏可用，单张导出可直接存到相册。
- **版权证书**：`veilmark.certificate/v1`，把“图中指纹 ↔ 创作者公钥 ↔ 文件哈希”绑在一起并签名；可附 `.cert.json`，也可写进 PNG 的 iTXt 块。验证页和命令行给出同一份逐项核对清单。

> 签名只证明“这把密钥的持有者在 issuedAt 时自行声明了这些内容”，不是权威时间戳，也不是法律意义上的权属认定。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm test` | 单元测试（载荷、CDP 抗攻击、伪隐性、排版、模板、实时预览、证书、签名身份、PNG iTXt、命令行核验） |
| `npm run verify:cert -- 图片 [证书] [--source 原图] [--trust keyId]` | 离线核验版权证书，PNG 内嵌证书时可省略证书参数 |
| `npm run bench:blind -- <图片...>` | 盲水印鲁棒性基准：CDP vs SVD-QIM × 17 种攻击 |
| `npm run bench:glance -- <图片...>` | 伪隐性水印“适屏可见度 vs 盗用后显形度”基准 |
| `npm run typecheck` / `npm run lint` / `npm run build` | 类型检查 / Lint / 生产构建 |

## 技术栈

Next.js 16（App Router，静态）· React 19 · Tailwind v4 · appica-ui + shadcn/ui（Luma，Base UI）· Web Worker + Comlink · OffscreenCanvas · WebGL2 · WebCrypto Ed25519（回退 @noble/ed25519）· onnxruntime-web（TrustMark，懒加载）· jSquash WebP · zustand · IndexedDB
