#!/bin/sh
# 下载 Adobe TrustMark（MIT）ONNX 模型到 public/models/trustmark，供浏览器懒加载。
# 变体：Q（默认，平衡）· C（紧凑，解码器 22MB）· B · P（感知优化）
set -e
VARIANT=${1:-Q}
DEST="$(dirname "$0")/../public/models/trustmark"
BASE="https://cai-watermark.adobe.net/watermarking/trustmark-models"
mkdir -p "$DEST"
for f in "encoder_$VARIANT" "decoder_$VARIANT"; do
  if [ -f "$DEST/$f.onnx" ]; then echo "✓ $f.onnx 已存在"; continue; fi
  echo "↓ $f.onnx"
  curl -fL --progress-bar -o "$DEST/$f.onnx" "$BASE/$f.onnx"
done
echo "完成：$DEST"
