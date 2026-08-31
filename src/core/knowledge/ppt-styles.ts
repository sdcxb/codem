/**
 * PPT 风格系统 — 1:1 对标 oh-my-ppt 的 76 种风格 Skill
 *
 * 每种风格包含: 配色方案(精确色值)、字体、背景类型/渐变、装饰元素、排版偏好
 * 数据来源: oh-my-ppt/resources/styles/ SKILL.md + style.json
 * Style vs Theme: Style includes colors, fonts, spacing, decorations, background, layout
 */

// ========== 字体定义 ==========

export interface FontDef {
  id: string;
  name: string;
  family: string;
  category: 'sans-serif' | 'serif' | 'monospace' | 'handwriting';
  googleFontUrl?: string;
  cjk?: boolean;
}

export const PPT_FONTS: FontDef[] = [
  { id: 'noto-sans-sc', name: 'Noto Sans SC', family: "'Noto Sans SC', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap', cjk: true },
  { id: 'noto-serif-sc', name: 'Noto Serif SC', family: "'Noto Serif SC', serif", category: 'serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap', cjk: true },
  { id: 'zcool-xiaowei', name: '站酷小薇', family: "'ZCOOL XiaoWei', serif", category: 'serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=ZCOOL+XiaoWei&display=swap', cjk: true },
  { id: 'zcool-kuaiLe', name: '站酷快乐体', family: "'ZCOOL KuaiLe', sans-serif", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap', cjk: true },
  { id: 'ma-shan-zheng', name: '马善政', family: "'Ma Shan Zheng', cursive", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap', cjk: true },
  { id: 'long-cang', name: '龙藏', family: "'Long Cang', cursive", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Long+Cang&display=swap', cjk: true },
  { id: 'liu-jian-mao-cao', name: '柳建毛草', family: "'Liu Jian Mao Cao', cursive", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Liu+Jian+Mao+Cao&display=swap', cjk: true },
  { id: 'inter', name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap' },
  { id: 'roboto', name: 'Roboto', family: "'Roboto', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap' },
  { id: 'poppins', name: 'Poppins', family: "'Poppins', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap' },
  { id: 'playfair-display', name: 'Playfair Display', family: "'Playfair Display', serif", category: 'serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap' },
  { id: 'merriweather', name: 'Merriweather', family: "'Merriweather', serif", category: 'serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap' },
  { id: 'source-code-pro', name: 'Source Code Pro', family: "'Source Code Pro', monospace", category: 'monospace', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;700&display=swap' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", category: 'monospace', googleFontUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap' },
  { id: 'bebas-neue', name: 'Bebas Neue', family: "'Bebas Neue', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap' },
  { id: 'space-grotesk', name: 'Space Grotesk', family: "'Space Grotesk', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap' },
  { id: 'montserrat', name: 'Montserrat', family: "'Montserrat', sans-serif", category: 'sans-serif', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap' },
  { id: 'dancing-script', name: 'Dancing Script', family: "'Dancing Script', cursive", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap' },
  { id: 'caveat', name: 'Caveat', family: "'Caveat', cursive", category: 'handwriting', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&display=swap' },
  { id: 'fira-code', name: 'Fira Code', family: "'Fira Code', monospace", category: 'monospace', googleFontUrl: 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap' },
  { id: 'system-ui', name: '系统默认', family: "'Segoe UI', 'Microsoft YaHei', sans-serif", category: 'sans-serif' },
  { id: 'microsoft-yahei', name: '微软雅黑', family: "'Microsoft YaHei', 'Segoe UI', sans-serif", category: 'sans-serif', cjk: true },
];

export function getFontById(id: string): FontDef | undefined {
  return PPT_FONTS.find(f => f.id === id);
}

export function loadGoogleFonts(): void {
  if (document.getElementById('ppt-google-fonts')) return;
  for (const f of PPT_FONTS) {
    if (f.googleFontUrl) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = f.googleFontUrl;
      document.head.appendChild(link);
    }
  }
  const marker = document.createElement('meta');
  marker.id = 'ppt-google-fonts';
  document.head.appendChild(marker);
}

// ========== 风格定义 ==========

export type StyleCategory = 'light-pro' | 'light-soft' | 'light-minimal' | 'dark-tech' | 'dark-luxury' | 'dark-sober' | 'bold' | 'vibrant' | 'effect' | 'magazine' | 'warm' | 'illustration' | 'chinese' | 'nature';

export type BackgroundType = 'solid' | 'gradient' | 'gradient-diagonal' | 'gradient-radial' | 'texture' | 'multi-gradient';

export type DecorationType =
  | 'none' | 'left-bar' | 'top-bar' | 'bottom-bar' | 'top-bottom-bar'
  | 'corner-triangle' | 'circle-accent' | 'gradient-band' | 'geometric'
  | 'dots' | 'split-color' | 'grid' | 'neon-line' | 'glitch'
  | 'ink-wash' | 'watercolor' | 'memphis' | 'magazine' | 'bauhaus'
  | 'glassmorphism' | 'neon-haze' | 'gradient-glow' | 'ascii-art'
  | 'color-blocks' | 'swiss-line' | 'editorial-serif' | 'terminal';

export interface PPTStyle {
  id: string;
  name: string;
  category: StyleCategory;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    textMuted: string;
  };
  backgroundType: BackgroundType;
  backgroundGradient?: string;
  decoration: DecorationType;
  titleFontId: string;
  bodyFontId: string;
  titleSizeMultiplier: number;
  bodySizeMultiplier: number;
  elementSpacing: number;
  titleAlign: 'left' | 'center' | 'right';
  pagePadding: number;
  thumbColor: string;
  description: string;
  /** AI 生成时的风格提示词 (对标 oh-my-ppt SKILL.md) */
  skillPrompt?: string;
  supportsImageGen?: boolean;
}

/** 风格构造辅助函数 — 缩短定义长度 */
function s(
  id: string, name: string, cat: StyleCategory,
  p: string, sec: string, acc: string, bg: string, txt: string, tm: string,
  bgType: BackgroundType, bgGrad: string | undefined, deco: DecorationType,
  tFont: string, bFont: string, tMul: number, bMul: number,
  spacing: number, tAlign: 'left' | 'center' | 'right', pad: number,
  thumb: string, desc: string, skillPrompt?: string,
): PPTStyle {
  return {
    id, name, category: cat,
    colors: { primary: p, secondary: sec, accent: acc, background: bg, text: txt, textMuted: tm },
    backgroundType: bgType, backgroundGradient: bgGrad, decoration: deco,
    titleFontId: tFont, bodyFontId: bFont,
    titleSizeMultiplier: tMul, bodySizeMultiplier: bMul,
    elementSpacing: spacing, titleAlign: tAlign, pagePadding: pad,
    thumbColor: thumb, description: desc, skillPrompt,
  };
}

// ========== 1:1 复制 oh-my-ppt 的 76 种风格 ==========

export const PPT_STYLES: PPTStyle[] = [
  // ────── 浅色 · 专业 ──────
  s('academic-paper', '学术论文', 'light-pro',
    '#171717', '#404040', '#2563eb', '#fafafa', '#171717', '#666666',
    'gradient', 'linear-gradient(145deg, #fafafa 0%, #f5f5f5 55%, #e5e5e5 100%)', 'left-bar',
    'merriweather', 'noto-sans-sc', 1.0, 0.9, 3, 'center', 8, '#171717',
    '黑墨蓝链落在论文白上，学术严谨自带说服力',
    '学术论文风格：论文白底渐变，墨黑标题蓝链强调。衬线正文+无衬线标题。单栏或双栏排版，标题居中。'),

  s('blue-white-chart', '蓝白商务图表', 'light-pro',
    '#305598', '#00329d', '#4472c4', '#ffffff', '#262626', '#404040',
    'solid', undefined, 'top-bar',
    'noto-sans-sc', 'roboto', 1.0, 0.95, 2, 'left', 5, '#305598',
    '冷静专业的数据汇报风',
    '蓝白商务图表：白底深蓝骨架。标题靠左+深蓝横线分隔。KPI卡片+图表区+结论条。数字大号加粗。'),

  s('corporate-clean', '企业洁净', 'light-pro',
    '#0f172a', '#334155', '#1e3a8a', '#ffffff', '#0f172a', '#64748b',
    'gradient', 'linear-gradient(145deg, #ffffff 0%, #f8fafc 55%, #f1f5f9 100%)', 'left-bar',
    'inter', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#1e3a8a',
    '纯白上海军蓝落笔，商务场合最稳妥的选择',
    '企业洁净：纯白底渐变带蓝灰。海军蓝标题+蓝色强调。规整卡片式布局，对齐严格。'),

  s('classic-duo-blue', '经典双色·米黄深蓝', 'light-pro',
    '#1660ab', '#0d3d6e', '#b8860b', '#fbf5e6', '#2c2416', '#5a5040',
    'gradient', 'linear-gradient(145deg, #fffcf2 0%, #fbf5e6 50%, #f9f2e0 100%)', 'left-bar',
    'playfair-display', 'noto-serif-sc', 1.1, 1.0, 2.5, 'center', 6, '#1660ab',
    '暖米黄配深海蓝，高级沉稳书卷气',
    '经典双色：暖米黄底+深海蓝。衬线标题金棕强调。细金线装饰几何边框。'),

  s('engineering-whiteprint', '工程白图', 'light-pro',
    '#1e3a5f', '#2c3e50', '#3498db', '#ffffff', '#1e3a5f', '#6c7b8b',
    'texture', 'repeating-linear-gradient(0deg, transparent, transparent 39px, #e8edf2 40px), repeating-linear-gradient(90deg, transparent, transparent 39px, #e8edf2 40px), #ffffff', 'grid',
    'jetbrains-mono', 'inter', 1.0, 0.95, 2, 'left', 5, '#1e3a5f',
    '坐标纸上海军墨线勾勒蓝图，工程思维可视化',
    '工程白图：白底坐标网格纸。深蓝墨线+等宽字体。工程标注框卡片。流程图和架构图。'),

  s('industrial-kaizen', '现代周报表格', 'light-pro',
    '#1a1a2e', '#16213e', '#0f3460', '#f8f9fa', '#1a1a2e', '#6c7b8b',
    'solid', undefined, 'top-bottom-bar',
    'inter', 'inter', 0.95, 0.9, 2, 'left', 5, '#0f3460',
    '克制的中性色表格驱动商务风',
    '现代周报：克制中性色，表格驱动。标题左上+上下分隔线。数据表格为核心。'),

  s('pitch-deck-vc', '融资路演', 'light-pro',
    '#4f46e5', '#3730a3', '#06b6d4', '#ffffff', '#1e1b4b', '#6b7280',
    'gradient', 'linear-gradient(135deg, #ffffff 0%, #f0f0ff 50%, #e0e7ff 100%)', 'gradient-band',
    'inter', 'inter', 1.1, 1.0, 2, 'left', 6, '#4f46e5',
    '蓝紫渐变在白底绽放，每一个数字都在说服投资人',
    '融资路演：白底蓝紫渐变。大数字+KPI卡片。标题左上+渐变横条。简洁有力。'),

  // ────── 浅色 · 柔和 ──────
  s('catppuccin-latte', 'Catppuccin 拿铁', 'light-soft',
    '#4c4f69', '#5c5f77', '#1e66f5', '#eff1f5', '#4c4f69', '#6c6f89',
    'gradient', 'linear-gradient(145deg, #eff1f5 0%, #e6e9ef 55%, #ccd0da 100%)', 'none',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 7, '#1e66f5',
    '拿铁浅底映粉彩，开发者的午后该有这样的温柔',
    'Catppuccin拿铁：浅灰蓝底渐变。柔和粉彩蓝青强调。等宽字体友好。浅色卡片层级靠色彩区分。'),

  s('chinese-cream-blossom', '米白樱粉', 'light-soft',
    '#f091a0', '#b23a48', '#d4a574', '#f5f2e9', '#3d3d3d', '#7a6b5d',
    'solid', undefined, 'circle-accent',
    'noto-serif-sc', 'noto-serif-sc', 1.2, 1.0, 3, 'center', 8, '#f091a0',
    '宣纸米白配樱粉，温柔雅致国风',
    '米白樱粉：宣纸米底+樱粉主色。胭脂红强调印章。思源宋体标题。花瓣留白点缀。'),

  s('chinese-fresh-trio', '青绿湖蓝', 'light-soft',
    '#7bcfa6', '#66a9c9', '#c0392b', '#e6f5f2', '#333333', '#4a4a4a',
    'solid', undefined, 'color-blocks',
    'noto-serif-sc', 'noto-sans-sc', 1.1, 1.0, 2.5, 'center', 7, '#7bcfa6',
    '翠绿湖蓝米白三色，清朗国风现代',
    '青绿湖蓝：三色色块分区。翠竹绿+湖蓝+米白。朱红印章强调。方正清刻本悦宋。'),

  s('cream-pastel', '奶油温柔', 'light-soft',
    '#5c5248', '#9a9488', '#c9a876', '#fbf7f2', '#5c5248', '#8a7e72',
    'gradient', 'linear-gradient(145deg, #fbf7f2 0%, #f5ede5 50%, #ebe4db 100%)', 'circle-accent',
    'poppins', 'inter', 1.1, 1.0, 3, 'left', 7, '#c9a876',
    '奶油白豆沙粉抹茶绿的温柔高级风',
    '奶油温柔：奶油白底渐变。豆沙粉+抹茶绿+暖驼色。柔和色块卡片大圆角。大量留白。'),

  s('healing-color-card', '情绪疗愈色卡', 'light-soft',
    '#7c6c8a', '#a8b1a0', '#d4a373', '#faf6f1', '#4a4a4a', '#8a8a8a',
    'gradient', 'linear-gradient(145deg, #faf6f1 0%, #f0ebe4 50%, #e8e0d5 100%)', 'circle-accent',
    'poppins', 'inter', 1.0, 1.0, 3, 'center', 7, '#d4a373',
    '薰衣草暖桃薄荷，柔软治愈情绪色',
    '情绪疗愈：暖底渐变。薰衣草紫+暖桃+薄荷绿。柔和色卡排列。圆角大卡片。'),

  s('sakura-soft-healing', '樱花治愈', 'light-soft',
    '#d4a0a0', '#c08080', '#e8c0c0', '#fdf5f5', '#5a4040', '#8a6a6a',
    'gradient', 'linear-gradient(145deg, #fdf5f5 0%, #f9e8e8 50%, #f5dada 100%)', 'dots',
    'noto-serif-sc', 'noto-sans-sc', 1.1, 1.0, 3, 'center', 7, '#d4a0a0',
    '莫兰迪低饱和樱花慢生活',
    '樱花治愈：低饱和粉底渐变。莫兰迪粉+灰粉。花瓣点缀留白。思源宋体标题。'),

  s('soft-pastel', '柔和马卡龙', 'light-soft',
    '#6b9080', '#a4c3b2', '#cce3da', '#f6fff9', '#3a4a3a', '#6a8a7a',
    'gradient', 'linear-gradient(145deg, #f6fff9 0%, #e8f5ee 50%, #d4e9dd 100%)', 'dots',
    'poppins', 'inter', 1.1, 1.0, 3, 'center', 7, '#6b9080',
    '马卡龙三色在画布上轻轻晕开，柔软得像一声早安',
    '柔和马卡龙：薄荷绿+粉粉+淡黄三色。极柔渐变底。圆点装饰。圆润字体。'),

  s('solarized-light', '日光浅', 'light-soft',
    '#586e75', '#657b83', '#268bd2', '#fdf6e3', '#586e75', '#839496',
    'gradient', 'linear-gradient(145deg, #fdf6e3 0%, #f5efdc 50%, #eee8d5 100%)', 'left-bar',
    'source-code-pro', 'source-code-pro', 1.0, 0.95, 2.5, 'left', 6, '#268bd2',
    '低眩光暖黄抚平视觉疲劳，八小时会议也不刺眼',
    '日光浅：Solarized暖黄底。蓝绿强调色。等宽字体。低眩光长时间观看。'),

  s('xiaohongshu-white', '小红书白', 'light-soft',
    '#e63946', '#f1faee', '#457b9d', '#ffffff', '#1d3557', '#6c757d',
    'solid', undefined, 'left-bar',
    'noto-serif-sc', 'noto-sans-sc', 1.15, 1.0, 2.5, 'left', 6, '#e63946',
    '暖红点缀白底衬线，生活方式的每一帧都值得收藏',
    '小红书白：纯白底+暖红强调。衬线标题。清单/步骤/对比结构。小红书图文笔记风。'),

  // ────── 浅色 · 极简 ──────
  s('minimal-white', '极简白', 'light-minimal',
    '#0f172a', '#475569', '#3b82f6', '#ffffff', '#0f172a', '#94a3b8',
    'gradient', 'linear-gradient(145deg, #ffffff 0%, #f8fafc 55%, #f1f5f9 100%)', 'none',
    'inter', 'inter', 1.1, 1.0, 3, 'left', 8, '#3b82f6',
    '克制到极致的高级感，留白是最有力的表达',
    '极简白：纯白渐变底。深墨标题蓝链强调。大量留白是核心。Inter字体标题偏粗。'),

  s('japanese-minimal', '日式极简', 'light-minimal',
    '#1a1a1a', '#404040', '#c8506e', '#f5f5f0', '#1a1a1a', '#808080',
    'solid', undefined, 'none',
    'noto-serif-sc', 'noto-sans-sc', 1.2, 0.95, 4, 'center', 10, '#c8506e',
    '象牙白上一笔朱红，万物留白处见匠心',
    '日式极简：象牙白底+一笔朱红。极简留白。思源宋体标题居中。禅意排版。'),

  // ────── 深色 · 科技 ──────
  s('catppuccin-mocha', 'Catppuccin 摩卡', 'dark-tech',
    '#c6d0f5', '#a5adce', '#8caaee', '#303446', '#c6d0f5', '#a5adce',
    'gradient-radial', 'radial-gradient(circle at 20% 0%, #303446 0%, #24273a 50%, #1e2030 100%)', 'none',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 7, '#8caaee',
    '摩卡柔雾中的粉彩光点，长时间凝视也不会疲倦',
    'Catppuccin摩卡：深灰蓝底渐变。柔蓝粉彩强调。等宽字体。柔和层级靠色彩区分。'),

  s('dracula', 'Dracula 紫', 'dark-tech',
    '#f8f8f2', '#bdbdbd', '#bd93f9', '#282a36', '#f8f8f2', '#6272a4',
    'gradient', 'linear-gradient(135deg, #282a36 0%, #21222c 50%, #1a1b20 100%)', 'neon-line',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#bd93f9',
    '紫夜笼罩屏幕，每一行代码都在荧光中呼吸',
    'Dracula紫：深紫灰底渐变。荧光粉紫+青绿强调。等宽字体。代码展示核心场景。'),

  s('gruvbox-dark', 'Gruvbox 暗', 'dark-tech',
    '#ebdbb2', '#d5c4a1', '#fabd2f', '#282828', '#ebdbb2', '#a89984',
    'gradient', 'linear-gradient(135deg, #282828 0%, #1d2021 50%, #1a1818 100%)', 'left-bar',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#fabd2f',
    '琥珀与苔绿在暖灰中燃烧，终端美学从未如此温暖',
    'Gruvbox暗：深暖灰底。琥珀黄+苔绿+橙红强调。等宽字体。暖色终端美学。'),

  s('nord', '北欧', 'dark-tech',
    '#88c0d0', '#81a1c1', '#88c0d0', '#2e3440', '#d8dee9', '#4c566a',
    'gradient', 'linear-gradient(135deg, #2e3440 0%, #3b4252 50%, #434c5e 100%)', 'left-bar',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#88c0d0',
    '极夜蓝底映冰蓝微光，安静到只听得见思考的声音',
    '北欧Nord：极夜蓝底渐变。冰蓝微光强调。等宽字体。安静层次靠色彩。'),

  s('rose-pine', '玫瑰松', 'dark-tech',
    '#e0def4', '#cdcdda', '#ebbcba', '#191724', '#e0def4', '#908caa',
    'gradient', 'linear-gradient(135deg, #191724 0%, #1f1d2e 50%, #26233a 100%)', 'left-bar',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#ebbcba',
    '暗紫森林里玫瑰静默绽放，设计感与代码温柔共存',
    '玫瑰松：暗紫底渐变。玫瑰粉+松青强调。等宽字体。设计感+代码温柔共存。'),

  s('terminal-green', '终端绿', 'dark-tech',
    '#00ff41', '#00cc33', '#0f0', '#000000', '#00ff41', '#008822',
    'solid', undefined, 'terminal',
    'source-code-pro', 'source-code-pro', 1.0, 1.0, 2, 'left', 5, '#00ff41',
    '绿屏荧光在黑暗中闪烁，终端美学最原始的浪漫',
    '终端绿：纯黑底+荧光绿。等宽字体。扫描线装饰。终端命令行风格。'),

  s('tokyo-night', '东京夜', 'dark-tech',
    '#7dcfff', '#bb9af7', '#7aa2f7', '#1a1b26', '#c0caf5', '#565f89',
    'gradient', 'linear-gradient(135deg, #1a1b26 0%, #16161e 50%, #131015 100%)', 'neon-line',
    'fira-code', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#7aa2f7',
    '深蓝底幕上浮起青色光晕，属于深夜程序员的视觉独白',
    '东京夜：深蓝底渐变。青色光晕+紫色强调。等宽字体。深夜程序员风格。'),

  s('arctic-cool', '北极冷', 'dark-sober',
    '#0c4a6e', '#0369a1', '#0284c7', '#f0f9ff', '#0c4a6e', '#0369a1',
    'gradient', 'linear-gradient(145deg, #f0f9ff 0%, #e0f2fe 50%, #bae6fd 100%)', 'top-bar',
    'inter', 'inter', 1.0, 0.95, 2.5, 'left', 6, '#0284c7',
    '冰蓝渐变裹住冷静理性，数据在这里找到尊严',
    '北极冷：浅蓝三段渐变底。深海蓝标题+青蓝强调。数据展示清晰。大面积浅蓝留白。'),

  // ────── 深色 · 奢华 ──────
  s('burgundy-premium', '勃艮第红高级感', 'dark-luxury',
    '#81021f', '#000000', '#f8b37f', '#0a0a0a', '#f8b37f', '#363636',
    'gradient', 'linear-gradient(135deg, #0a0a0a 0%, #1a0008 50%, #0a0a0a 100%)', 'gradient-band',
    'bebas-neue', 'inter', 1.3, 1.0, 3, 'center', 6, '#81021f',
    '沉稳奢华的红金黑配色',
    '勃艮第红：黑底+深酒红+玫瑰金。粗体几何标题字间距宽。金线分隔。色块阵列。高级奢华。'),

  s('gold-ivory', '鎏金象牙', 'dark-luxury',
    '#b8860b', '#1a1a1a', '#d4af37', '#1a1a1a', '#e8e0c8', '#8a7c5a',
    'gradient', 'linear-gradient(135deg, #1a1a1a 0%, #2a2520 50%, #1a1a1a 100%)', 'gradient-band',
    'playfair-display', 'noto-serif-sc', 1.2, 1.0, 3, 'center', 6, '#d4af37',
    '鎏金棕与象牙白的古典奢华风',
    '鎏金象牙：深棕黑底+鎏金强调。衬线标题。古典奢华质感。金色线条装饰。'),

  s('olive-elegant', '橄榄奶白', 'dark-luxury',
    '#5a6b3f', '#3d4a2a', '#c9b99a', '#2a2e22', '#e0d8c0', '#8a8470',
    'gradient', 'linear-gradient(135deg, #2a2e22 0%, #3a3528 50%, #2a2e22 100%)', 'gradient-band',
    'playfair-display', 'noto-serif-sc', 1.1, 1.0, 3, 'center', 6, '#5a6b3f',
    '深橄榄绿与奶白绿的古典奢华风',
    '橄榄奶白：深橄榄绿底+奶白绿强调。衬线标题。古典稳重奢华。'),

  // ────── 深色 · 沉稳 ──────
  s('gradient-cosmic', '星河烟火', 'dark-sober',
    '#1e1b4b', '#312e81', '#f59e0b', '#0c0a1e', '#e0e0ff', '#6c6a9a',
    'gradient-diagonal', 'linear-gradient(135deg, #0c0a1e 0%, #1a1340 30%, #0f0a28 60%, #1e1b4b 100%)', 'gradient-glow',
    'poppins', 'inter', 1.2, 1.0, 2.5, 'center', 6, '#f59e0b',
    '深靛暗夜金橙，史诗梦幻强对比',
    '星河烟火：深靛底+金橙强调。史诗梦幻渐变。大标题居中。强对比视觉。'),

  s('neon-haze', '深色弥散', 'dark-sober',
    '#6366f1', '#818cf8', '#c026d3', '#0f0a1e', '#e0e0ff', '#6c6a9a',
    'gradient-radial', 'radial-gradient(circle at 20% 80%, #2e1065 0%, #0f0a1e 60%), radial-gradient(circle at 80% 20%, #1e1b4b 0%, transparent 50%)', 'neon-haze',
    'space-grotesk', 'inter', 1.1, 1.0, 2.5, 'center', 6, '#6366f1',
    '深蓝紫底叠加霓虹弥散光的氛围感',
    '深色弥散：深蓝紫底+霓虹弥散光。氛围感拉满。模糊渐变光斑。现代无衬线。'),

  s('starlight-fireworks', '一半星河一半烟火', 'dark-sober',
    '#0f2249', '#1a3a6e', '#ff6b35', '#0a0f1e', '#e0e0ff', '#4a5a8a',
    'gradient-diagonal', 'linear-gradient(135deg, #0a0f1e 0%, #0f2249 50%, #1a3a6e 100%)', 'gradient-glow',
    'poppins', 'inter', 1.1, 1.0, 2.5, 'center', 6, '#ff6b35',
    '海军蓝暖焰橙对角，梦幻诗意二元',
    '星河烟火：深蓝底+暖焰橙强调。对角渐变。梦幻诗意二元。'),

  // ────── 效果 · 戏剧 ──────
  s('aurora', '极光', 'effect',
    '#1e1b4b', '#312e81', '#06b6d4', '#a7f3d0', '#1e1b4b', '#312e81',
    'multi-gradient', 'linear-gradient(135deg, #a7f3d0 0%, #6ee7b7 30%, #6366f1 60%, #a855f7 100%)', 'gradient-glow',
    'poppins', 'inter', 1.3, 1.0, 2, 'center', 5, '#6366f1',
    '极光渐变融化在blur里，封面页天生就该这样梦幻',
    '极光：翠绿到蓝紫四段渐变。高度透明卡片。大标题居中铺满。全屏渐变即布局本身。'),

  s('blueprint', '蓝图', 'effect',
    '#dbeafe', '#93c5fd', '#3b82f6', '#1e3a5f', '#dbeafe', '#93c5fd',
    'gradient', 'linear-gradient(145deg, #1e3a5f 0%, #1e40af 50%, #1d4ed8 100%)', 'grid',
    'jetbrains-mono', 'jetbrains-mono', 1.0, 0.95, 2, 'left', 5, '#60a5fa',
    '深蓝底上浅蓝线条织就网格，建筑师的梦想画布',
    '蓝图：深蓝三段渐变底+浅蓝网格。等宽字体。节点连线构成视觉主体。架构图流程图。'),

  s('cyberpunk-neon', '赛博霓虹', 'effect',
    '#f8fafc', '#cbd5e1', '#ec4899', '#0a0a0a', '#f8fafc', '#cbd5e1',
    'gradient-radial', 'radial-gradient(circle at 30% 10%, #1a1a2e 0%, #0f0f1a 50%, #000000 100%)', 'neon-line',
    'jetbrains-mono', 'jetbrains-mono', 1.1, 1.0, 2, 'left', 5, '#ec4899',
    '霓虹粉青撕裂纯黑夜幕，未来已来且不问你是否准备好',
    '赛博霓虹：纯黑底+霓虹粉青双光。等宽字体。发光text-shadow。故障glitch装饰。不对称布局。'),

  s('glassmorphism', '磨砂玻璃', 'effect',
    '#ffffff', '#e0e7ff', '#818cf8', '#e0e7ff', '#1e1b4b', '#6366f1',
    'multi-gradient', 'linear-gradient(135deg, #c7d2fe 0%, #e0e7ff 30%, #ddd6fe 60%, #f3e8ff 100%)', 'glassmorphism',
    'montserrat', 'inter', 1.1, 1.0, 2.5, 'center', 5, '#818cf8',
    '磨砂玻璃后光斑流转，Apple 发布会的光影魔术',
    '磨砂玻璃：彩色渐变底+半透明磨砂卡片。backdrop-filter blur。圆角大卡片。浮动光斑。'),

  s('rainbow-gradient', '彩虹渐变', 'effect',
    '#7c3aed', '#db2777', '#059669', '#ffffff', '#1e1b4b', '#6b7280',
    'multi-gradient', 'linear-gradient(135deg, #fef3c7 0%, #fecaca 20%, #fbbf24 40%, #a7f3d0 60%, #93c5fd 80%, #c4b5fd 100%)', 'gradient-glow',
    'poppins', 'inter', 1.2, 1.0, 2.5, 'center', 5, '#7c3aed',
    '彩虹在白底流动，每一帧都是庆祝的理由',
    '彩虹渐变：白底+七色流动渐变。大标题居中。庆祝感。色块排列。'),

  s('vaporwave', '蒸汽波', 'effect',
    '#ff71ce', '#01cdfe', '#05ffa1', '#1a0033', '#ff71ce', '#6b5b95',
    'gradient', 'linear-gradient(135deg, #1a0033 0%, #2d1b4e 30%, #3d2b6e 60%, #1a0033 100%)', 'gradient-glow',
    'space-grotesk', 'inter', 1.2, 1.0, 2.5, 'center', 5, '#ff71ce',
    '深紫渐变中粉红与青蓝晕染，怀旧美学抵达意识深处',
    '蒸汽波：深紫底+粉红青蓝晕染。霓虹text-shadow。网格地平线。复古未来主义。'),

  s('y2k-chrome', 'Y2K 铬', 'effect',
    '#c0c0c0', '#e0e0e0', '#ff00ff', '#2a2a2a', '#e0e0e0', '#808080',
    'gradient', 'linear-gradient(135deg, #1a1a2e 0%, #16213e 30%, #0f3460 60%, #1a1a2e 100%)', 'gradient-glow',
    'space-grotesk', 'inter', 1.2, 1.0, 2.5, 'center', 5, '#c0c0c0',
    '银铬反射彩虹光斑，千禧年的未来主义从未过时',
    'Y2K铬：深蓝底+银铬彩虹光斑。金属质感渐变。千禧未来主义。'),

  s('amber-aurora', '扁豆紫蜜陀僧', 'effect',
    '#9e7059', '#ec954e', '#f4d9b0', '#fbf3e8', '#5a3a1a', '#8a6a4a',
    'gradient', 'linear-gradient(180deg, #9e7059 0%, #c47a4a 40%, #ec954e 70%, #f4d9b0 100%)', 'gradient-glow',
    'ma-shan-zheng', 'noto-sans-sc', 1.2, 1.0, 3, 'center', 6, '#ec954e',
    '暖紫橙渐变的黄昏国风治愈',
    '扁豆紫蜜陀僧：垂直天-云-水三段式。紫在上橙在下。书法标题。半透明米白卡片。'),

  // ────── 大胆 · 宣言 ──────
  s('bauhaus', '包豪斯', 'bold',
    '#991b1b', '#1e3a5f', '#dc2626', '#fef3c7', '#1d3557', '#5a6c7d',
    'gradient', 'linear-gradient(160deg, #fef3c7 0%, #fef9c3 50%, #f0f9ff 100%)', 'bauhaus',
    'poppins', 'inter', 1.3, 1.0, 2, 'left', 5, '#dc2626',
    '原色碰撞的几何宣言，每一页都是蒙德里安式的视觉震动',
    '包豪斯：暖色画布+红黄蓝三原色。几何色块骨架。粗体标题宽字间距。不对称网格。'),

  s('memphis-pop', '孟菲斯波普', 'bold',
    '#ff006e', '#8338ec', '#3a86ff', '#ffbe0b', '#1a1a2e', '#5a5a7a',
    'gradient', 'linear-gradient(135deg, #ffbe0b 0%, #ff006e 50%, #8338ec 100%)', 'memphis',
    'space-grotesk', 'inter', 1.3, 1.0, 2, 'center', 5, '#ff006e',
    '霓虹渐变洒满画布，孟菲斯派对永不散场',
    '孟菲斯波普：霓虹渐变底+多色撞色。几何图形+波点+锯齿。派对狂欢感。'),

  s('neo-brutalism', '新野兽派', 'bold',
    '#1a1a1a', '#ffffff', '#ff3e00', '#f5f5f0', '#1a1a1a', '#666666',
    'solid', undefined, 'bauhaus',
    'space-grotesk', 'inter', 1.3, 1.0, 1.5, 'left', 4, '#ff3e00',
    '粗线条硬阴影，用不妥协的姿态说出你的观点',
    '新野兽派：米白底+黑硬边框+硬阴影。橙红强调色。粗线条偏移投影。不妥协大胆。'),

  s('sharp-mono', '锐利黑白', 'bold',
    '#000000', '#1a1a1a', '#ffffff', '#ffffff', '#000000', '#666666',
    'solid', undefined, 'swiss-line',
    'space-grotesk', 'inter', 1.3, 1.0, 2, 'left', 5, '#000000',
    '黑白利刃切开视觉噪音，硬朗到骨子里',
    '锐利黑白：纯黑白对比。无彩色。极硬朗几何线条。标题超大超粗。'),

  s('swiss-grid', '瑞士网格', 'bold',
    '#1a1a1a', '#333333', '#e63946', '#ffffff', '#1a1a1a', '#666666',
    'solid', undefined, 'swiss-line',
    'poppins', 'inter', 1.2, 1.0, 2.5, 'left', 6, '#e63946',
    '严谨到像素的网格信仰，理性本身就是一种浪漫',
    '瑞士网格：纯白底+严格网格。红黑极简。几何精确对齐。标题靠左。'),

  // ────── 活力 · 创意 ──────
  s('cobalt-sunshine', '明黄钴蓝', 'vibrant',
    '#0b2299', '#1e3a8a', '#ffe470', '#ffe470', '#0b2299', '#5a5a8a',
    'solid', undefined, 'split-color',
    'poppins', 'inter', 1.2, 1.0, 2, 'left', 5, '#0b2299',
    '明黄与钴蓝的高饱和互补色撞色',
    '明黄钴蓝：黄蓝互补撞色。大色块交替。粗体大字。高饱和。'),

  s('dopamine-clash', '多巴胺活力撞色', 'vibrant',
    '#c026d3', '#059669', '#fbbf24', '#faf5ff', '#1a1a2e', '#6b6b8a',
    'gradient', 'linear-gradient(135deg, #fef3c7 0%, #fce7f3 30%, #ddd6fe 60%, #cffafe 100%)', 'color-blocks',
    'poppins', 'inter', 1.2, 1.0, 2, 'center', 5, '#c026d3',
    '淡紫亮绿玫粉的高饱和年轻撞色',
    '多巴胺撞色：浅多彩渐变底+高饱和色块。年轻活力。大圆角卡片。'),

  s('dreamy-pink-gradient', '樱粉雾蓝', 'vibrant',
    '#8b5cf6', '#6366f1', '#ec4899', '#fdf2f8', '#1e1b4b', '#7c6cf0',
    'gradient-diagonal', 'linear-gradient(135deg, #fdf2f8 0%, #e0e7ff 50%, #c7d2fe 100%)', 'gradient-glow',
    'poppins', 'inter', 1.15, 1.0, 2.5, 'center', 5, '#8b5cf6',
    '樱粉雾紫深靛渐变，梦幻浪漫诗意',
    '樱粉雾蓝：粉紫渐变底。柔粉+雾蓝+深靛。梦幻浪漫。圆角大卡片。'),

  s('dreamy-romance', '梦幻浪漫', 'vibrant',
    '#a78bfa', '#8b5cf6', '#f9a8d4', '#fdf4ff', '#4c1d95', '#9333ea',
    'gradient', 'linear-gradient(135deg, #fdf4ff 0%, #fae8ff 30%, #e9d5ff 60%, #ddd6fe 100%)', 'gradient-glow',
    'dancing-script', 'inter', 1.2, 1.0, 3, 'center', 6, '#a78bfa',
    '雾紫樱花粉星空蓝的梦幻浪漫治愈风',
    '梦幻浪漫：柔紫粉渐变底+樱花粉+星空蓝。手写体标题。梦幻治愈。'),

  s('macaron-mist', '柔雾甜梦', 'vibrant',
    '#a78bfa', '#6ee7b7', '#fbbf24', '#fef3c7', '#5b4b8a', '#8a7ab0',
    'gradient', 'linear-gradient(135deg, #fef3c7 0%, #fce7f3 30%, #ddd6fe 60%, #cffafe 100%)', 'circle-accent',
    'poppins', 'inter', 1.15, 1.0, 2.5, 'center', 6, '#a78bfa',
    '薄荷粉珊瑚薰衣草紫的柔雾甜点风',
    '柔雾甜梦：马卡龙色渐变底。薄荷+粉+紫+珊瑚。圆润字体。甜点感。'),

  s('splash-abstract', '泼彩抽象', 'vibrant',
    '#7c3aed', '#059669', '#f59e0b', '#fffbfa', '#1a1a2e', '#6b6b8a',
    'gradient', 'linear-gradient(135deg, #fffbfa 0%, #fef3c7 30%, #fae8ff 60%, #cffafe 100%)', 'color-blocks',
    'space-grotesk', 'inter', 1.2, 1.0, 2.5, 'center', 5, '#7c3aed',
    '五色泼墨多巴胺，张扬活力创意',
    '泼彩抽象：白底+五色泼墨色块。张扬大胆。不对称色块。'),

  s('starry-dust', '星屑柔光', 'vibrant',
    '#a78bfa', '#c4b5fd', '#f9a8d4', '#1e1b4b', '#e0e0ff', '#6c6a9a',
    'gradient', 'linear-gradient(135deg, #2a1b4e 0%, #1e1b4b 50%, #1a1540 100%)', 'gradient-glow',
    'poppins', 'inter', 1.15, 1.0, 2.5, 'center', 6, '#a78bfa',
    '雾紫香槟粉星空蓝的柔光童话风',
    '星屑柔光：深紫底+柔光星屑。香槟粉+星空蓝。童话梦幻。'),

  // ────── 杂志 · 编辑 ──────
  s('editorial-serif', '杂志衬线', 'magazine',
    '#1a1a1a', '#404040', '#c0392b', '#faf6ef', '#1a1a1a', '#7a7a7a',
    'solid', undefined, 'editorial-serif',
    'playfair-display', 'merriweather', 1.2, 1.0, 3, 'left', 7, '#c0392b',
    '奶油纸上衬线娓娓道来，故事感从标题开始流淌',
    '杂志衬线：奶油纸底+衬线大标题。红色强调。左对齐叙事排版。'),

  s('magazine-bold', '杂志大字', 'magazine',
    '#1a1a1a', '#333333', '#e63946', '#fffbf0', '#1a1a1a', '#666666',
    'solid', undefined, 'editorial-serif',
    'bebas-neue', 'inter', 1.4, 1.0, 2.5, 'left', 6, '#e63946',
    '奶油纸上跃动超大衬线，翻开的每一页都是封面',
    '杂志大字：奶油纸底+超大无衬线标题。红色强调。满版大字封面感。'),

  s('midcentury', '世纪中叶', 'magazine',
    '#c2700c', '#1d3557', '#2a9d8f', '#fffbf0', '#1a1a1a', '#6b6b6b',
    'solid', undefined, 'circle-accent',
    'playfair-display', 'inter', 1.15, 1.0, 2.5, 'left', 6, '#c2700c',
    '芥末黄遇上焦橙与青，世纪中叶的客厅永远舒适',
    '世纪中叶：暖米底+芥末黄+焦橙+青色。复古衬线。几何装饰。客厅舒适感。'),

  s('news-broadcast', '新闻播报', 'magazine',
    '#dc2626', '#1a1a1a', '#fbbf24', '#ffffff', '#1a1a1a', '#6b7280',
    'solid', undefined, 'left-bar',
    'montserrat', 'inter', 1.1, 0.95, 2, 'left', 5, '#dc2626',
    '红色竖条亮起，所有目光聚焦——突发新闻，不容错过',
    '新闻播报：白底+红色竖条+黑大字。黄色强调。 Breaking News 紧迫感。'),

  s('premium-color-blocking', '高级撞色', 'magazine',
    '#1e3a5f', '#ff6b35', '#fbbf24', '#1e3a5f', '#ffffff', '#8a9ab0',
    'gradient-diagonal', 'linear-gradient(135deg, #1e3a5f 0%, #1e3a5f 50%, #ff6b35 50%, #ff6b35 100%)', 'split-color',
    'bebas-neue', 'inter', 1.3, 1.0, 2.5, 'left', 5, '#ff6b35',
    '暖橙撞墨蓝的时尚编辑大片气质',
    '高级撞色：蓝橙对半切割。大标题压在撞色交界。时尚大片感。'),

  s('retro-tv', '复古电视', 'magazine',
    '#f4a261', '#e76f51', '#2a9d8f', '#fff8e1', '#3d2c1d', '#8b7355',
    'solid', undefined, 'bauhaus',
    'space-grotesk', 'inter', 1.15, 1.0, 2.5, 'center', 5, '#e76f51',
    '暖黄屏幕闪烁琥珀光，时间倒流回客厅里的CRT',
    '复古电视：暖黄底+琥珀屏幕。复古CRT边框。时光倒流感。'),

  // ────── 暖色 · 治愈 ──────
  s('children-warm-orange', '童趣橙暖', 'warm',
    '#70d422', '#fe7f08', '#ffaddd', '#ff7f00', '#5a3a1a', '#8a6a3a',
    'gradient', 'linear-gradient(180deg, #ff7f00 0%, #ffa500 50%, #ffbb3e 100%)', 'circle-accent',
    'zcool-kuaiLe', 'noto-sans-sc', 1.3, 1.0, 2, 'center', 5, '#ff7f00',
    '活泼可爱的儿童节橙暖风',
    '童趣橙暖：暖橙渐变底+草绿+粉点缀。圆润手写体。大圆角卡片。童趣活泼。'),

  s('orange-sea', '晴橙落日海', 'warm',
    '#ff6b35', '#f7931e', '#4ecdc4', '#fff5eb', '#3d2c1d', '#8b7355',
    'gradient', 'linear-gradient(145deg, #fff5eb 0%, #ffe8d6 30%, #ffd4c4 60%, #ffb088 100%)', 'gradient-glow',
    'caveat', 'inter', 1.15, 1.0, 3, 'center', 6, '#ff6b35',
    '晴空蓝柔杏白落日橙的治愈渐变',
    '晴橙落日海：暖渐变底+落日橙+晴空蓝。手写体标题。治愈感渐变。'),

  s('summer-warm-color', '夏日暖色', 'warm',
    '#f4a261', '#e76f51', '#2a9d8f', '#fffbf0', '#3d2c1d', '#8b7355',
    'gradient', 'linear-gradient(145deg, #fffbf0 0%, #fff3e0 30%, #ffe8d6 60%, #ffdcc6 100%)', 'circle-accent',
    'caveat', 'inter', 1.15, 1.0, 2.5, 'center', 6, '#e76f51',
    '清新治愈的夏日绘本风',
    '夏日暖色：暖白渐变底+橙红+青绿。手写体标题。绘本插画感。'),

  s('sunset-warm', '日落暖', 'warm',
    '#ff6b6b', '#ee5a6f', '#feca57', '#fff5f5', '#2d1b1b', '#8b6b6b',
    'gradient-diagonal', 'linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 50%, #feca57 100%)', 'gradient-glow',
    'poppins', 'inter', 1.2, 1.0, 2.5, 'center', 6, '#ff6b6b',
    '橘色珊瑚琥珀三色铺满天际，温度本身就是叙事',
    '日落暖：橘珊瑚琥珀三色渐变。暖色铺满。温度即叙事。'),

  // ────── 插画 · 手绘 ──────
  s('hand-drawn-autumn', '手绘秋日旅行手账', 'illustration',
    '#8b4513', '#a0522d', '#daa520', '#fff8dc', '#3d2b1d', '#6b5b4f',
    'texture', 'repeating-linear-gradient(0deg, transparent, transparent 28px, #f5e6d033 29px, transparent 30px), #fff8dc', 'dots',
    'caveat', 'inter', 1.15, 1.0, 3, 'left', 6, '#8b4513',
    '温暖秋日色调的手绘插画风格，充满童趣与旅行感',
    '手绘秋日：手账纸底+秋日暖色。手写体。手账横线纹理。旅行插画感。'),

  s('handdrawn-watercolor', '治愈手绘水彩', 'illustration',
    '#4a90a4', '#5cb8a0', '#f4a261', '#f0f8ff', '#2c3e50', '#6b8898',
    'gradient', 'linear-gradient(145deg, #f0f8ff 0%, #e0f0ff 30%, #d4eaff 60%, #c8e0ff 100%)', 'watercolor',
    'caveat', 'inter', 1.15, 1.0, 3, 'left', 6, '#4a90a4',
    '低饱和暖色与海洋蓝交织，治愈感从纸面上流淌而出',
    '手绘水彩：水彩底+低饱和暖色+海洋蓝。手写体。水彩晕染装饰。治愈感。'),

  s('mountain-green-literary', '山野葱郁', 'illustration',
    '#2d5016', '#3d6b1f', '#c9a227', '#f0f5e8', '#1a2e10', '#4a6b3a',
    'gradient', 'linear-gradient(145deg, #f0f5e8 0%, #e0ead0 30%, #d0e0b8 60%, #c0d098 100%)', 'watercolor',
    'noto-serif-sc', 'noto-sans-sc', 1.1, 1.0, 3, 'left', 6, '#2d5016',
    '深绿山峦黄草地的文艺夏日',
    '山野葱郁：浅绿渐变底+深绿山峦+黄草地。衬线标题。文艺夏日。'),

  // ────── 东方 · 国风 ──────
  s('chinese-ink-landscape', '中式水墨意境·山水', 'chinese',
    '#4a90a4', '#8b9dc3', '#a93226', '#f4f1ea', '#2c3e50', '#5d6d7e',
    'gradient', 'linear-gradient(145deg, #f4f1ea 0%, #ede7da 50%, #e0d8ca 100%)', 'ink-wash',
    'ma-shan-zheng', 'noto-serif-sc', 1.3, 1.0, 4, 'center', 8, '#4a90a4',
    '青灰山色暖沙米，深远辽阔山水意境',
    '中式水墨山水：宣纸米底+青黛蓝+朱砂。书法标题。山水层叠装饰。大幅留白。'),

  s('chinese-pastel-spring', '春日嫩柳', 'chinese',
    '#a8bf8f', '#c5d99e', '#c0392b', '#f7f3e8', '#3a3a3a', '#5a4030',
    'gradient', 'linear-gradient(145deg, #f7f3e8 0%, #f0f5e0 50%, #e8efc8 100%)', 'ink-wash',
    'noto-serif-sc', 'noto-sans-sc', 1.2, 1.0, 3, 'center', 7, '#a8bf8f',
    '嫩柳绿配桃花粉，初春国风温柔配色',
    '春日嫩柳：宣纸底+嫩柳绿+桃花粉。朱砂强调。衬线标题。桃花柳叶点缀。'),

  s('chinese-porcelain-rose', '凝脂杨妃', 'chinese',
    '#f091a0', '#f5f2e9', '#b23a48', '#faf7f0', '#333333', '#666666',
    'solid', undefined, 'circle-accent',
    'noto-serif-sc', 'noto-serif-sc', 1.1, 1.0, 3, 'center', 7, '#f091a0',
    '凝脂杨妃双主色，瓷韵典雅国风',
    '凝脂杨妃：暖米白底+杨妃粉。胭脂红+淡金强调。思源宋体。对称居中。'),

  s('indigo-lotus', '青莲碧蓝', 'chinese',
    '#3a5a8a', '#5b7baa', '#c04060', '#1a1a3e', '#e0e0f0', '#6a6a8a',
    'gradient', 'linear-gradient(135deg, #1a1a3e 0%, #2a2a5e 50%, #1a1a3e 100%)', 'gradient-glow',
    'ma-shan-zheng', 'noto-serif-sc', 1.2, 1.0, 3, 'center', 6, '#3a5a8a',
    '紫蓝渐变的黄昏海天国风',
    '青莲碧蓝：深蓝紫底+青莲+碧蓝。朱砂强调。书法标题。黄昏海天意境。'),

  s('ink-wash-jiangnan', '水墨江南', 'chinese',
    '#2c3e50', '#34495e', '#c0392b', '#f5f0e8', '#2c3e50', '#6b5b4f',
    'gradient', 'linear-gradient(145deg, #f5f0e8 0%, #ede8dc 50%, #e0d8ca 100%)', 'ink-wash',
    'ma-shan-zheng', 'noto-serif-sc', 1.3, 1.0, 4, 'center', 8, '#2c3e50',
    '水墨意境，江南烟雨的东方诗意',
    '水墨江南：宣纸底+水墨灰+朱砂。书法标题。烟雨水墨晕染。大幅留白。'),

  s('oriental-poetic-illustration', '东方意境插画', 'chinese',
    '#3a5a4a', '#5a7a6a', '#c0392b', '#f0f5e8', '#2c3e30', '#5a6b5a',
    'gradient', 'linear-gradient(145deg, #f0f5e8 0%, #e8f0e0 50%, #d8e8d0 100%)', 'ink-wash',
    'noto-serif-sc', 'noto-sans-sc', 1.2, 1.0, 3.5, 'center', 7, '#3a5a4a',
    '竹影月色，禅意诗画的东方插画',
    '东方意境插画：淡绿底+竹青+月白。朱砂强调。衬线标题。竹影月色装饰。'),

  s('palace-ink-red', '故宫墨红', 'chinese',
    '#8b0000', '#1a1a1a', '#d4af37', '#f5f0e8', '#2c2416', '#6b5b4f',
    'solid', undefined, 'corner-triangle',
    'zcool-xiaowei', 'noto-serif-sc', 1.3, 1.0, 2.5, 'center', 6, '#8b0000',
    '厚重墨红配宣纸米灰，新中式高级感的东方力量',
    '故宫墨红：宣纸米底+深红+墨黑+金。站酷小薇标题。故宫庄严感。'),

  s('song-rain-poetic', '宋人生活·听雨', 'chinese',
    '#5a7a8a', '#7a9aaa', '#c9a227', '#eef2f0', '#2c3e40', '#5a6a6a',
    'gradient', 'linear-gradient(145deg, #eef2f0 0%, #e0e8e6 50%, #d4dedc 100%)', 'ink-wash',
    'noto-serif-sc', 'noto-sans-sc', 1.2, 1.0, 3.5, 'center', 7, '#5a7a8a',
    '雾蓝嫩绿暖黄，宋人听雨新中式',
    '宋人听雨：淡雾蓝底+嫩绿+暖黄。衬线标题。宋人诗意。雨意水墨晕染。'),

  // ────── 自然 · 有机 ──────
  s('mint-fresh', '薄荷清新', 'nature',
    '#06d6a0', '#048a64', '#ffd166', '#f0fff9', '#1a3c34', '#5a8a7a',
    'gradient-radial', 'radial-gradient(circle at 20% 20%, #e0fff5 0%, #f0fff9 70%)', 'dots',
    'poppins', 'inter', 1.1, 1.0, 2.5, 'left', 6, '#06d6a0',
    '低饱和高明度的高级感绿色系',
    '薄荷清新：浅绿渐变底+薄荷绿+暖黄。圆点装饰。清新自然。'),

  s('chinese-pastel-spring-nature', '春日嫩柳绿', 'nature',
    '#a8bf8f', '#c5d99e', '#f3a694', '#f7f3e8', '#3a3a3a', '#5a4030',
    'gradient', 'linear-gradient(145deg, #f7f3e8 0%, #f0f5e0 50%, #e8efc8 100%)', 'ink-wash',
    'noto-serif-sc', 'noto-sans-sc', 1.2, 1.0, 3, 'center', 7, '#a8bf8f',
    '嫩柳绿配桃花粉，初春国风温柔配色',
    '春日嫩柳绿：宣纸底+嫩柳绿+桃花粉。衬线标题。初春温柔。'),
];

// ========== 旧风格ID兼容映射 ==========

/** 旧风格 ID → 新风格 ID 映射（向后兼容） */
const OLD_STYLE_ID_MAP: Record<string, string> = {
  'business-blue': 'corporate-clean',
  'business-dark': 'dracula',
  'business-navy': 'blue-white-chart',
  'business-charcoal': 'industrial-kaizen',
  'business-gold': 'gold-ivory',
  'academic-clean': 'academic-paper',
  'academic-paper': 'academic-paper',
  'academic-serif': 'classic-duo-blue',
  'minimal-white': 'minimal-white',
  'minimal-gray': 'minimal-white',
  'minimal-black': 'sharp-mono',
  'minimal-swiss': 'swiss-grid',
  'creative-coral': 'sunset-warm',
  'creative-mint': 'mint-fresh',
  'creative-sunset': 'sunset-warm',
  'creative-purple': 'dreamy-romance',
  'creative-bauhaus': 'bauhaus',
  'dark-cyber': 'cyberpunk-neon',
  'dark-midnight': 'tokyo-night',
  'dark-obsidian': 'catppuccin-mocha',
  'dark-terminal': 'terminal-green',
  'playful-candy': 'macaron-mist',
  'playful-lego': 'memphis-pop',
  'playful-cartoon': 'children-warm-orange',
  'tech-blue': 'arctic-cool',
  'tech-grid': 'blueprint',
  'tech-holographic': 'vaporwave',
  'tech-data': 'blue-white-chart',
  'chinese-ink': 'ink-wash-jiangnan',
  'chinese-red': 'palace-ink-red',
  'chinese-bamboo': 'oriental-poetic-illustration',
  'chinese-porcelain': 'chinese-porcelain-rose',
};

// ========== 查找函数 ==========

export function getStyleById(id: string): PPTStyle | undefined {
  // 先直接查找
  let style = PPT_STYLES.find(s => s.id === id);
  if (style) return style;
  // 旧 ID 兼容
  const mappedId = OLD_STYLE_ID_MAP[id];
  if (mappedId) {
    return PPT_STYLES.find(s => s.id === mappedId);
  }
  return undefined;
}

export function getStylesByCategory(category: StyleCategory): PPTStyle[] {
  return PPT_STYLES.filter(s => s.category === category);
}

// ========== 风格分类标签 ==========

export const STYLE_CATEGORY_LABELS: Record<StyleCategory, string> = {
  'light-pro': '浅色 · 专业',
  'light-soft': '浅色 · 柔和',
  'light-minimal': '浅色 · 极简',
  'dark-tech': '深色 · 科技',
  'dark-luxury': '深色 · 奢华',
  'dark-sober': '深色 · 沉稳',
  'bold': '大胆 · 宣言',
  'vibrant': '活力 · 创意',
  'effect': '效果 · 戏剧',
  'magazine': '杂志 · 编辑',
  'warm': '暖色 · 治愈',
  'illustration': '插画 · 手绘',
  'chinese': '东方 · 国风',
  'nature': '自然 · 有机',
};

// ========== 画布尺寸 ==========

export interface CanvasSize {
  id: string;
  name: string;
  width: number;
  height: number;
  icon: string;
  description: string;
}

export const CANVAS_SIZES: CanvasSize[] = [
  { id: '16:9', name: '宽屏 16:9', width: 1920, height: 1080, icon: '🖥️', description: '标准宽屏，适合投影' },
  { id: '4:3', name: '标准 4:3', width: 1024, height: 768, icon: '📺', description: '传统比例，适合旧设备' },
  { id: '16:10', name: '宽屏 16:10', width: 1280, height: 800, icon: '💻', description: '笔记本比例' },
  { id: '9:16', name: '竖屏 9:16', width: 720, height: 1280, icon: '📱', description: '手机竖屏，适合短视频' },
  { id: '1:1', name: '方图 1:1', width: 1080, height: 1080, icon: '⬜', description: '正方形，适合社交媒体' },
  { id: '3:4', name: '竖版 3:4', width: 864, height: 1152, icon: '📄', description: 'A4 竖版比例' },
  { id: '21:9', name: '超宽 21:9', width: 2520, height: 1080, icon: '🎬', description: '电影超宽比例' },
  { id: '2:3', name: '小红书 2:3', width: 720, height: 1080, icon: '📕', description: '小红书图文比例' },
];

export function getCanvasSizeById(id: string): CanvasSize | undefined {
  return CANVAS_SIZES.find(s => s.id === id);
}

// ========== 风格 → 兼容 PPTTheme ==========

export function styleToTheme(style: PPTStyle): {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
} {
  const titleFont = getFontById(style.titleFontId);
  const bodyFont = getFontById(style.bodyFontId);
  return {
    id: style.id,
    name: style.name,
    primaryColor: style.colors.primary,
    secondaryColor: style.colors.secondary,
    accentColor: style.colors.accent,
    backgroundColor: style.colors.background,
    textColor: style.colors.text,
    fontFamily: `${titleFont?.family || bodyFont?.family || 'sans-serif'}`,
  };
}

/** 生成风格的背景 CSS */
export function getStyleBackground(style: PPTStyle): string {
  if (style.backgroundType === 'solid' || !style.backgroundGradient) {
    return style.colors.background;
  }
  return style.backgroundGradient;
}