#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 DeepSeek Harness 桌面端图标：深蓝渐变圆角方块 + 鲸鱼剪影 + 波浪"""
import math
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
R = 200  # 圆角半径

# ---- 渐变底色（深蓝 → 靛蓝）----
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
px = img.load()
top = (13, 27, 62)     # #0D1B3E
mid = (30, 58, 138)    # #1E3A8A
bot = (59, 130, 246)   # #3B82F6
for y in range(SIZE):
    t = y / SIZE
    if t < 0.55:
        k = t / 0.55
        c = tuple(int(top[i] + (mid[i] - top[i]) * k) for i in range(3))
    else:
        k = (t - 0.55) / 0.45
        c = tuple(int(mid[i] + (bot[i] - mid[i]) * k) for i in range(3))
    for x in range(SIZE):
        px[x, y] = (*c, 255)

# ---- 圆角遮罩 ----
mask = Image.new('L', (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
img.putalpha(mask)

# ---- 内部细亮边（玻璃感）----
glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, outline=(255, 255, 255, 90), width=6)
img = Image.alpha_composite(img, glow)

# ---- 鲸鱼剪影 ----
whale = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
wd = ImageDraw.Draw(whale)

def blob(cx, cy, rx, ry, color):
    """画一个椭圆，模拟鲸鱼身体段"""
    wd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color)

WHITE = (255, 255, 255, 245)

# 身体：三段椭圆叠成流线型
blob(340, 560, 190, 130, WHITE)   # 尾段
blob(520, 540, 200, 150, WHITE)   # 中段
blob(700, 500, 150, 120, WHITE)   # 头段

# 头部圆润 + 嘴部
wd.ellipse([820, 430, 960, 600], fill=WHITE)
wd.polygon([(900, 470), (980, 505), (905, 540)], fill=WHITE)  # 吻部

# 尾巴
wd.polygon([(150, 500), (60, 400), (130, 470), (180, 420), (170, 520)], fill=WHITE)
wd.polygon([(150, 620), (60, 700), (130, 640), (180, 680), (170, 600)], fill=WHITE)

# 眼睛（深色圆点）
wd.ellipse([840, 470, 875, 505], fill=(10, 20, 50, 255))

# 鳍
wd.pieslice([450, 560, 620, 760], 200, 330, fill=WHITE)

# 平滑一下
whale = whale.filter(ImageFilter.GaussianBlur(1.2))
img = Image.alpha_composite(img, whale)

# ---- 底部波浪线 ----
wave = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
wd2 = ImageDraw.Draw(wave)
pts = []
for x in range(80, SIZE - 80, 4):
    y = 780 + 18 * math.sin(x / 60.0) + 10 * math.sin(x / 23.0)
    pts.append((x, y))
wd2.line(pts, fill=(255, 255, 255, 130), width=10)
wd2.line([(x, y + 40) for x, y in pts], fill=(255, 255, 255, 80), width=8)
img = Image.alpha_composite(img, wave)

# ---- 导出 ----
img.save('build/icon.png')

# ico（多尺寸）
img.resize((256, 256), Image.LANCZOS).save('build/icon.ico',
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icons generated: build/icon.png, build/icon.ico')
