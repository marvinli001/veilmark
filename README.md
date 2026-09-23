# Veilmark · 图片版权水印工坊

显性水印、智能伪隐性水印、算法盲水印三合一的轻量 Web 工具。三种水印可以多选叠加，支持批量处理；所有处理都在浏览器本地完成，部署为纯静态站点。

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

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm test` | 单元测试（载荷、CDP 抗攻击、伪隐性不可见/显形、排版） |
| `npm run bench:blind -- <图片...>` | 盲水印鲁棒性基准：CDP vs SVD-QIM × 17 种攻击 |
| `npm run bench:glance -- <图片...>` | 伪隐性水印“适屏可见度 vs 盗用后显形度”基准 |
| `npm run typecheck` / `npm run lint` / `npm run build` | 类型检查 / Lint / 生产构建 |

## 技术栈

Next.js 16（App Router，静态）· React 19 · Tailwind v4 · appica-ui + shadcn/ui（Luma，Base UI）· Web Worker + Comlink · OffscreenCanvas · onnxruntime-web（TrustMark，懒加载）· jSquash WebP · zustand · IndexedDB
