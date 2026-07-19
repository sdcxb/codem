/**
 * 主题色提取器
 * 从图片中提取主色调，用于梦幻皮肤自适应主题色
 */

import type { ExtractedPalette } from './types';

/** RGB 颜色 */
interface RGB {
  r: number;
  g: number;
  b: number;
}

/** HSL 颜色 */
interface HSL {
  h: number;
  s: number;
  l: number;
}

/** K-Means 聚类中心 */
interface Cluster {
  centroid: RGB;
  pixels: RGB[];
  count: number;
}

const SAMPLE_SIZE = 100;        // 采样图片大小（100x100）
const K_CLUSTERS = 6;           // 聚类中心数
const MAX_ITERATIONS = 10;      // 最大迭代次数
const MIN_BRIGHTNESS = 0.15;    // 过滤太暗的像素
const MAX_BRIGHTNESS = 0.95;    // 过滤太亮的像素

export class ThemeExtractor {
  /**
   * 从图片 URL 提取色板
   * @param imageSrc 图片 URL 或 base64 data URL
   * @returns 提取的色板
   */
  static async extractPalette(imageSrc: string): Promise<ExtractedPalette> {
    const pixels = await this.sampleImage(imageSrc);
    const clusters = this.kMeans(pixels, K_CLUSTERS);
    const sortedClusters = clusters.sort((a, b) => b.count - a.count);

    // 主色调：像素最多的聚类
    const dominant = sortedClusters[0]?.centroid ?? { r: 128, g: 128, b: 128 };

    // 强调色：饱和度最高的聚类（非主色调）
    let accent = dominant;
    let maxSaturation = -1;
    for (const cluster of sortedClusters) {
      if (cluster === sortedClusters[0]) continue;
      const hsl = this.rgbToHsl(cluster.centroid);
      if (hsl.s > maxSaturation && hsl.s > 0.1) {
        maxSaturation = hsl.s;
        accent = cluster.centroid;
      }
    }
    // 如果没找到合适的强调色，使用主色调
    if (maxSaturation < 0) {
      accent = this.adjustSaturation(dominant, 0.3);
    }

    // 平均亮度判断明暗
    const avgLuminance = this.calculateAverageLuminance(pixels);
    const isDark = avgLuminance < 0.5;

    // 背景色：基于平均亮度和主色调
    const background = isDark
      ? this.darken(dominant, 0.85)
      : this.lighten(dominant, 0.92);

    // 文本色：基于背景色的反色
    const textPrimary = isDark ? '#f0f0f0' : this.darken(dominant, 0.4);
    const textSecondary = isDark ? '#a0a0a0' : this.lighten(this.darken(dominant, 0.3), 0.3);

    // 完整色板
    const palette = sortedClusters.slice(0, 6).map(c => this.rgbToHex(c.centroid));

    return {
      dominant: this.rgbToHex(dominant),
      accent: this.rgbToHex(accent),
      background: this.rgbToHex(background),
      textPrimary,
      textSecondary,
      isDark,
      palette,
    };
  }

  /**
   * 加载图片并采样像素
   */
  private static async sampleImage(imageSrc: string): Promise<RGB[]> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('无法获取 Canvas 2D 上下文'));
          return;
        }
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const imageData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const pixels: RGB[] = [];
        for (let i = 0; i < imageData.data.length; i += 4) {
          const r = imageData.data[i];
          const g = imageData.data[i + 1];
          const b = imageData.data[i + 2];
          const a = imageData.data[i + 3];
          // 跳过透明像素
          if (a < 128) continue;
          // 过滤太亮或太暗的像素
          const luminance = this.getLuminance(r, g, b);
          if (luminance < MIN_BRIGHTNESS || luminance > MAX_BRIGHTNESS) continue;
          pixels.push({ r, g, b });
        }
        resolve(pixels);
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = imageSrc;
    });
  }

  /**
   * K-Means 颜色聚类
   */
  private static kMeans(pixels: RGB[], k: number): Cluster[] {
    if (pixels.length === 0) {
      return [{ centroid: { r: 128, g: 128, b: 128 }, pixels: [], count: 0 }];
    }

    // 初始化聚类中心：随机选择 k 个像素
    const centroids: RGB[] = [];
    const step = Math.floor(pixels.length / k);
    for (let i = 0; i < k; i++) {
      centroids.push({ ...pixels[i * step] });
    }

    let clusters: Cluster[] = centroids.map(c => ({ centroid: c, pixels: [], count: 0 }));

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // 分配像素到最近的聚类中心
      clusters = clusters.map(c => ({ ...c, pixels: [], count: 0 }));
      for (const pixel of pixels) {
        let minDist = Infinity;
        let minIdx = 0;
        for (let i = 0; i < centroids.length; i++) {
          const dist = this.colorDistance(pixel, centroids[i]);
          if (dist < minDist) {
            minDist = dist;
            minIdx = i;
          }
        }
        clusters[minIdx].pixels.push(pixel);
        clusters[minIdx].count++;
      }

      // 更新聚类中心
      let changed = false;
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].pixels.length === 0) continue;
        const newCentroid = this.averageColor(clusters[i].pixels);
        if (this.colorDistance(newCentroid, centroids[i]) > 1) {
          changed = true;
        }
        centroids[i] = newCentroid;
        clusters[i].centroid = newCentroid;
      }
      if (!changed) break;
    }

    return clusters;
  }

  /**
   * 计算颜色距离（欧几里得距离）
   */
  private static colorDistance(a: RGB, b: RGB): number {
    return Math.sqrt(
      Math.pow(a.r - b.r, 2) +
      Math.pow(a.g - b.g, 2) +
      Math.pow(a.b - b.b, 2)
    );
  }

  /**
   * 计算颜色平均值
   */
  private static averageColor(pixels: RGB[]): RGB {
    if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
    const sum = pixels.reduce(
      (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
      { r: 0, g: 0, b: 0 }
    );
    return {
      r: Math.round(sum.r / pixels.length),
      g: Math.round(sum.g / pixels.length),
      b: Math.round(sum.b / pixels.length),
    };
  }

  /**
   * 计算亮度（0-1）
   */
  static getLuminance(r: number, g: number, b: number): number {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  /**
   * 计算平均亮度
   */
  private static calculateAverageLuminance(pixels: RGB[]): number {
    if (pixels.length === 0) return 0.5;
    const sum = pixels.reduce((acc, p) => acc + this.getLuminance(p.r, p.g, p.b), 0);
    return sum / pixels.length;
  }

  /**
   * RGB 转 HSL
   */
  private static rgbToHsl(rgb: RGB): HSL {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s, l };
  }

  /**
   * RGB 转 Hex 字符串
   */
  static rgbToHex(rgb: RGB): string {
    return `#${[rgb.r, rgb.g, rgb.b]
      .map((x) => Math.round(x).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  /**
   * 加深颜色
   */
  private static darken(rgb: RGB, factor: number): RGB {
    return {
      r: Math.round(rgb.r * factor),
      g: Math.round(rgb.g * factor),
      b: Math.round(rgb.b * factor),
    };
  }

  /**
   * 提亮颜色
   */
  private static lighten(rgb: RGB, factor: number): RGB {
    return {
      r: Math.round(rgb.r + (255 - rgb.r) * factor),
      g: Math.round(rgb.g + (255 - rgb.g) * factor),
      b: Math.round(rgb.b + (255 - rgb.b) * factor),
    };
  }

  /**
   * 调整饱和度
   */
  private static adjustSaturation(rgb: RGB, targetSaturation: number): RGB {
    const hsl = this.rgbToHsl(rgb);
    hsl.s = targetSaturation;
    return this.hslToRgb(hsl);
  }

  /**
   * HSL 转 RGB
   */
  private static hslToRgb(hsl: HSL): RGB {
    const h = hsl.h / 360;
    const s = hsl.s;
    const l = hsl.l;
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  }

  /**
   * 将文件转为 base64 data URL
   */
  static fileToDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * 压缩图片到指定尺寸
   */
  static async compressImage(imageSrc: string, maxWidth = 1920, maxHeight = 1080, quality = 0.85): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        if (height > maxHeight) {
          width = (width * maxHeight) / height;
          height = maxHeight;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('无法获取 Canvas 2D 上下文'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = imageSrc;
    });
  }
}
